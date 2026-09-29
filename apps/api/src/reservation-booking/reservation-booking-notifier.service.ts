import { Injectable, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DestinatairesAvisService } from '../agenda/destinataires-avis.service';
import { EmailService, type EmailTemplateId } from '../email/email.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';

/** Source des erreurs → visible dans le centre d'alerte admin (/admin/alerts). */
const SOURCE = 'RESERVATION_BOOKING';

/** Ce qu'un événement `reservation.*` porte : la ligne écrite, telle que le service l'a rendue. */
interface LigneEvenement {
  fleetId: string;
  vehiclePlate: string | null;
  startAt: string;
  endAt: string | null;
  /** Statut APRÈS l'écriture (absent chez un ancien émetteur). */
  status?: string | null;
  metadata: Record<string, unknown> | null;
}

/** L'état d'une demande groupée (`bookingRef`), relu en base au moment d'écrire. */
interface EtatGroupe {
  attend: boolean;
  plaquesAVenir: string[];
  /** Les lignes fermes encore à venir, avec LEUR créneau (contre-revue R3). */
  lignesAVenir: { plate: string; startAt: Date | null; endAt: Date | null }[];
}

/**
 * Refonte agenda/IA (2026-07, P4) — Notifications au DEMANDEUR d'un lien public.
 * Découplé du flux réservation : à la SOUMISSION (accusé de réception) et à la VALIDATION
 * (`@OnEvent('reservation.confirmed')`), au REFUS, à la MODIFICATION d'une réservation déjà
 * confirmée (`reservation.modified`, revue du 29/09) et à son ANNULATION (`reservation.cancelled`,
 * troisième relecture du 29/09). Canal : e-mail si le contact contient « @ », sinon SMS.
 * Best-effort : tout échec (envoi ou exception) est journalisé dans le CENTRE D'ALERTE admin via
 * ErrorLogger (source RESERVATION_BOOKING) — jamais d'exception propagée au flux métier.
 */
@Injectable()
export class ReservationBookingNotifier {
  constructor(
    private readonly email: EmailService,
    private readonly sms: SmsGatewayService,
    private readonly errors: ErrorLogger,
    private readonly prisma: PrismaService,
    /** Qui peut valider, et qui en est prévenu — règle unique, partagée avec l'écran des réglages. */
    private readonly destinataires: DestinatairesAvisService,
    /**
     * Socle de notification. `@Optional()` parce que les specs de ce fichier montent le service à
     * la main, et qu'un avis non poussé ne doit jamais empêcher un e-mail de partir.
     */
    @Optional() private readonly dispatch?: NotificationDispatchService,
  ) {}

  /** Accusé de réception (à la soumission publique) — e-mail AU THÈME (charte 2026). Best-effort. */
  async sendAcknowledgment(input: {
    fleetId: string;
    contact: string;
    destination: string | null;
    startAt: string;
    endAt: string;
    seats?: number | null;
    /** Sièges auto demandés (bébé / enfant) — rappelés au demandeur, il pourra corriger. */
    childSeats?: { baby: number; child: number } | null;
  }): Promise<void> {
    const built = this.email.buildReservationRequestedEmail({
      fleetName: await this.fleetNameOf(input.fleetId),
      slotLabel: this.fmtSlot(input.startAt, input.endAt),
      destination: input.destination,
      seats: input.seats ?? null,
      childSeatsLabel: this.libelleSieges(input.childSeats),
    });
    await this.notify(input.contact, input.fleetId, built, 'reservation_requested');
  }

  /**
   * Confirmation à la VALIDATION d'une réservation publique — e-mail AU THÈME.
   *
   * Troisième relecture du 29/09 (T5) — c'est souvent le PREMIER et le seul écrit du demandeur (F13 :
   * on se tait tant qu'une ligne sœur attend). Elle combinait le créneau de la ligne validée avec
   * TOUTES les plaques confirmées : une ligne scindée pendant l'attente (A lundi → jeudi, C jeudi →
   * vendredi) devenait « lundi → vendredi, Véhicule : A, C, B » — trois voitures toute la semaine, dont
   * une partie peut-être déjà écoulée. Même récapitulatif que la modification ({@link recapGroupe}) :
   * les lignes fermes À VENIR, une ligne « véhicule — créneau » dès que les créneaux diffèrent.
   */
  @OnEvent('reservation.confirmed', { async: true })
  async onConfirmed(payload: LigneEvenement): Promise<void> {
    const m = payload?.metadata;
    if (!m || m['public'] !== true) return; // uniquement les demandes publiques
    const contact = typeof m['requesterContact'] === 'string' ? (m['requesterContact'] as string) : '';
    if (!contact.trim()) return;
    const groupe = await this.etatDuGroupe(m);
    if (groupe.attend) return; // un frère encore en attente : on écrira à la dernière décision
    const built = this.email.buildReservationConfirmedEmail({
      fleetName: await this.fleetNameOf(payload.fleetId),
      destination: this.destinationDe(m),
      ...this.recapGroupe(groupe, payload),
    });
    await this.notify(contact, payload.fleetId, built, 'reservation_confirmed');
  }

  /**
   * C5 (revue du 29/09) — une réservation publique DÉJÀ CONFIRMÉE a changé de véhicule ou de créneau
   * (véhicule au garage → « Réaffecter », décalage en masse, édition). Le demandeur avait reçu une
   * confirmation nommant l'ancienne plaque et ne recevait plus rien : il se présentait pour une
   * voiture au garage. On lui renvoie SA confirmation, mise à jour et dite « modifiée ».
   *
   * Mêmes gardes que la confirmation (demande publique, un contact, F13 : on se tait tant qu'une ligne
   * sœur attend encore — la confirmation finale portera les bonnes plaques). Les plaques nommées sont
   * celles des lignes fermes ENCORE À VENIR : une réservation scindée garde sa partie écoulée sur
   * l'ancien véhicule, qu'il ne faut plus annoncer.
   *
   * Contre-revue du 29/09 :
   *  - R4 : rien pour une réservation TERMINÉE (fin passée) ni close ou annulée — corriger après coup
   *    le véhicule d'une sortie d'hier écrivait « votre réservation a été modifiée ». Le service ne
   *    l'émet plus ; ce garde couvre tout autre émetteur.
   *  - R3 : quand les lignes à venir d'une demande n'ont PLUS le même créneau (une seule a été décalée,
   *    ou une scission garde la voiture d'origine jusqu'à jeudi), le courriel ne combine plus le
   *    créneau d'une ligne avec les plaques de toutes : il écrit une ligne « véhicule — créneau »
   *    par véhicule.
   */
  @OnEvent('reservation.modified', { async: true })
  async onModified(payload: LigneEvenement): Promise<void> {
    const m = payload?.metadata;
    if (!m || m['public'] !== true) return; // uniquement les demandes publiques
    const contact = typeof m['requesterContact'] === 'string' ? (m['requesterContact'] as string) : '';
    if (!contact.trim()) return;
    // R4 — une réservation finie, close ou annulée ne concerne plus le demandeur.
    if (payload.status === 'DONE' || payload.status === 'CANCELLED') return;
    if (payload.endAt && new Date(payload.endAt).getTime() <= Date.now()) return;
    const groupe = await this.etatDuGroupe(m);
    if (groupe.attend) return;
    const built = this.email.buildReservationConfirmedEmail({
      fleetName: await this.fleetNameOf(payload.fleetId),
      destination: this.destinationDe(m),
      ...this.recapGroupe(groupe, payload),
      modifiee: true,
    });
    await this.notify(contact, payload.fleetId, built, 'reservation_confirmed');
  }

  /**
   * T2 (troisième relecture du 29/09) — une réservation publique DÉJÀ CONFIRMÉE a été ANNULÉE (par la
   * feuille, le panneau du jour, la décision « Annuler » d'une immobilisation ou « Réorganiser →
   * Annuler »). Le demandeur avait reçu « confirmée — AA-111-BB » et ne recevait plus rien : il se
   * présentait pour une réservation annulée. Le service n'émet que pour une ligne CONFIRMÉE, publique,
   * non rétroactive et pas encore finie, et une seule fois par demande pour un geste de masse.
   *
   * L'état du GROUPE tranche (relu en base, comme les autres courriels) :
   *  - une ligne sœur encore en attente : on se tait, la dernière décision écrira (F13) ;
   *  - des lignes fermes restent à venir : la demande n'est pas annulée, elle est MODIFIÉE — le
   *    courriel « modifiée » nomme les lignes RESTANTES, jamais la plaque ni le créneau de la ligne
   *    annulée (qui sont ceux de l'événement) ;
   *  - plus rien : « Votre réservation a été annulée ». Pas le texte du refus (« votre demande n'a pas
   *    pu être retenue ») : il est faux pour une réservation que le demandeur tenait pour ferme.
   */
  @OnEvent('reservation.cancelled', { async: true })
  async onCancelled(payload: LigneEvenement): Promise<void> {
    const m = payload?.metadata;
    if (!m || m['public'] !== true) return; // uniquement les demandes publiques
    const contact = typeof m['requesterContact'] === 'string' ? (m['requesterContact'] as string) : '';
    if (!contact.trim()) return;
    // Mêmes bornes que le service, pour tout autre émetteur : ni consignation, ni réservation finie.
    if (m['retroactive'] === true) return;
    if (payload.endAt && new Date(payload.endAt).getTime() <= Date.now()) return;
    const groupe = await this.etatDuGroupe(m);
    if (groupe.attend) return;
    if (groupe.lignesAVenir.length > 0) {
      await this.notify(contact, payload.fleetId, await this.confirmationDesLignesRestantes(groupe, payload, m, true), 'reservation_confirmed');
      return;
    }
    const built = this.email.buildReservationRefusedEmail({
      fleetName: await this.fleetNameOf(payload.fleetId),
      slotLabel: this.fmtSlot(payload.startAt, payload.endAt),
      destination: this.destinationDe(m),
      annulee: true,
    });
    // Même modèle journalisé que le refus : l'issue négative d'une demande publique (le sujet, lui,
    // distingue « annulée » de « non retenue » dans le journal des envois).
    await this.notify(contact, payload.fleetId, built, 'reservation_refused');
  }

  /**
   * La confirmation qui nomme les lignes fermes RESTANTES d'une demande, construite sur ELLES — la
   * première à venir sert de référence (créneau, plaque), jamais la ligne de l'événement, qui vient
   * d'être annulée ou refusée. `modifiee` : la demande avait déjà été confirmée au demandeur.
   */
  private async confirmationDesLignesRestantes(
    groupe: EtatGroupe,
    payload: LigneEvenement,
    m: Record<string, unknown>,
    modifiee: boolean,
  ): Promise<{ subject: string; text: string; html: string }> {
    const [premiere] = groupe.lignesAVenir;
    const reference = {
      vehiclePlate: premiere.plate,
      startAt: (premiere.startAt ?? new Date(payload.startAt)).toISOString(),
      endAt: premiere.endAt ? premiere.endAt.toISOString() : null,
    };
    return this.email.buildReservationConfirmedEmail({
      fleetName: await this.fleetNameOf(payload.fleetId),
      destination: this.destinationDe(m),
      ...this.recapGroupe(groupe, reference),
      ...(modifiee ? { modifiee: true } : {}),
    });
  }

  /**
   * LE récapitulatif d'une demande — confirmation, modification, annulation partielle (T5 : il vivait
   * dans la seule modification, et la confirmation finale mélangeait encore les lignes).
   *  - `slotLabel` / plaque unique : ceux de la ligne de référence ;
   *  - plusieurs véhicules à venir sur le MÊME créneau : leurs plaques, sur ce créneau ;
   *  - des créneaux qui diffèrent (une ligne décalée seule, une voiture gardée jusqu'à jeudi puis
   *    relayée) : une ligne « véhicule — créneau » par ligne ferme à venir. Une partie déjà écoulée
   *    d'une scission n'est plus annoncée (elle n'est pas « à venir »).
   * Sans `bookingRef` (ou journal illisible), le groupe est vide : la ligne de référence seule.
   */
  private recapGroupe(
    groupe: EtatGroupe,
    reference: { vehiclePlate: string | null; startAt: string; endAt: string | null },
  ): { slotLabel: string; vehicle: string | null; lignes?: { vehicle: string; slotLabel: string }[] } {
    const creneaux = new Set(groupe.lignesAVenir.map((l) => `${l.startAt?.getTime() ?? ''}|${l.endAt?.getTime() ?? ''}`));
    const lignes =
      creneaux.size > 1
        ? groupe.lignesAVenir.map((l) => ({
            vehicle: l.plate,
            slotLabel: this.fmtSlot(
              (l.startAt ?? new Date(reference.startAt)).toISOString(),
              l.endAt ? l.endAt.toISOString() : null,
            ),
          }))
        : undefined;
    return {
      slotLabel: this.fmtSlot(reference.startAt, reference.endAt),
      vehicle: groupe.plaquesAVenir.length > 1 ? groupe.plaquesAVenir.join(', ') : reference.vehiclePlate,
      ...(lignes ? { lignes } : {}),
    };
  }

  /** La destination saisie par le demandeur, si elle est lisible. */
  private destinationDe(m: Record<string, unknown>): string | null {
    return typeof m['destination'] === 'string' ? (m['destination'] as string) : null;
  }

  /**
   * F13 (recette prod du 28/09) — une demande publique de 11 places tient sur DEUX véhicules, qui
   * portent le même `bookingRef` : chaque décision émettait son événement, et le demandeur recevait
   * DEUX courriels de refus pour une seule demande (mesuré : `reservation_refused` × 2 à 09:37:11).
   * Un seul courriel par décision : on se tait tant qu'un frère est encore en attente, et l'on
   * écrit à la dernière décision — la confirmation nomme alors tous les véhicules retenus.
   * Sans `bookingRef` (demande à un seul véhicule, ou ancienne), rien ne change.
   */
  private async etatDuGroupe(m: Record<string, unknown>): Promise<EtatGroupe> {
    const vide: EtatGroupe = { attend: false, plaquesAVenir: [], lignesAVenir: [] };
    const ref = typeof m['bookingRef'] === 'string' ? (m['bookingRef'] as string) : '';
    if (!ref) return vide;
    try {
      const freres = await this.prisma.vehicleEvent.findMany({
        where: { type: 'RESERVATION', metadata: { path: ['bookingRef'], equals: ref } },
        select: { status: true, startAt: true, endAt: true, vehicle: { select: { plate: true } } },
      });
      const maintenant = Date.now();
      // Revue du 29/09 (C5) : après une scission, la partie écoulée (fermée à la coupe) garde
      // l'ancienne plaque — une modification n'annonce que les lignes fermes encore à venir.
      const aVenir = freres
        .filter(
          (f) => (f.status === 'CONFIRMED' || f.status === 'IN_PROGRESS') && (!f.endAt || new Date(f.endAt).getTime() > maintenant),
        )
        .sort((a, b) => (a.startAt ? new Date(a.startAt).getTime() : 0) - (b.startAt ? new Date(b.startAt).getTime() : 0));
      return {
        attend: freres.some((f) => f.status === 'REQUESTED'),
        plaquesAVenir: [...new Set(aVenir.map((f) => f.vehicle?.plate ?? '').filter(Boolean))],
        lignesAVenir: aVenir
          .filter((f) => !!f.vehicle?.plate)
          .map((f) => ({
            plate: f.vehicle?.plate ?? '',
            startAt: f.startAt ? new Date(f.startAt) : null,
            endAt: f.endAt ? new Date(f.endAt) : null,
          })),
      };
    } catch {
      // un journal illisible ne doit pas taire le demandeur
      return vide;
    }
  }

  /**
   * F16 (recette du 28/09) — REFUS d'une demande publique. Le demandeur recevait l'accusé de
   * réception puis la confirmation ; un refus ne lui disait rien, et il attendait un véhicule qui
   * ne viendrait pas. Même garde que la confirmation : demande publique, avec un contact.
   *
   * Troisième relecture du 29/09 (cas mixte, même famille que T2) — une ligne validée, l'autre
   * refusée : la validation s'était tue (une sœur attendait encore, F13), et le refus final écrivait
   * « votre demande n'a pas pu être retenue » — la confirmation de la ligne retenue n'arrivait jamais.
   * S'il reste des lignes fermes à venir, c'est LEUR confirmation qui part, nommant ce qui reste.
   */
  @OnEvent('reservation.refused', { async: true })
  async onRefused(payload: LigneEvenement): Promise<void> {
    const m = payload?.metadata;
    if (!m || m['public'] !== true) return; // uniquement les demandes publiques
    const contact = typeof m['requesterContact'] === 'string' ? (m['requesterContact'] as string) : '';
    if (!contact.trim()) return;
    const groupe = await this.etatDuGroupe(m);
    if (groupe.attend) return; // F13 : un seul courriel par demande, à la dernière décision
    if (groupe.lignesAVenir.length > 0) {
      await this.notify(contact, payload.fleetId, await this.confirmationDesLignesRestantes(groupe, payload, m, false), 'reservation_confirmed');
      return;
    }
    const built = this.email.buildReservationRefusedEmail({
      fleetName: await this.fleetNameOf(payload.fleetId),
      slotLabel: this.fmtSlot(payload.startAt, payload.endAt),
      destination: this.destinationDe(m),
    });
    await this.notify(contact, payload.fleetId, built, 'reservation_refused');
  }

  /**
   * P0-1 (2026-09-23) — PRÉVENIR CEUX QUI PEUVENT VALIDER.
   *
   * ┌─ LE TROU QUE CETTE MÉTHODE BOUCHE ────────────────────────────────────────┐
   * │ Ce service savait parler au demandeur deux fois (accusé de réception,     │
   * │ confirmation) et à la société ZÉRO fois. Entre les deux, la demande       │
   * │ s'écrivait en base et attendait qu'on la découvre — or le seul écran qui  │
   * │ l'affiche exige `reservations_manage` ET n'apparaît que si la demande     │
   * │ tombe dans le mois affiché. Mesuré le 22/09 : cdef31, lien actif, ouvert  │
   * │ 55 fois, `standard@cdef31.org` sans la permission. Une demande y serait   │
   * │ restée invisible pour toujours.                                           │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * DESTINATAIRES : ceux qui peuvent réellement VALIDER, c'est-à-dire dont les permissions
   * effectives portent `reservations_manage`. Pas « les admins » (recodés en dur, ils passeraient
   * à côté du standard, qui est justement le poste visé), pas « ceux qui reçoivent les alertes de
   * flotte » (c'est un autre réglage, qui parle des alertes véhicule).
   *
   * DEUX CANAUX, VOLONTAIREMENT :
   *  - l'e-mail, qui part vraiment aujourd'hui ;
   *  - le socle de notification (`notifyUsers`), qui applique préférences et anti-spam — et qui,
   *    tant que `PUSH_ROLLOUT=SUPER_ADMIN_ONLY`, ne poussera qu'aux super-admins. Le câbler
   *    maintenant évite d'avoir à y revenir le jour où le rollout s'ouvre.
   *
   * Best-effort intégral : cette méthode ne lève jamais. Une demande enregistrée dont la
   * notification échoue reste une demande enregistrée — on la trace, on ne la perd pas.
   */
  async notifyFleetOfPendingRequest(input: {
    fleetId: string;
    requester: string;
    contact: string;
    destination: string | null;
    startAt: string;
    endAt: string;
    seats: number | null;
    /** Sièges auto à installer (bébé / enfant) : le valideur doit le savoir avant de dire oui. */
    childSeats?: { baby: number; child: number } | null;
    vehicleCount: number;
  }): Promise<number> {
    try {
      /**
       * DEUX TROUS DIFFÉRENTS, DEUX MESSAGES DIFFÉRENTS.
       *
       * « Personne ne peut valider » est une société mal configurée — c'était cdef31 avant le
       * correctif de permissions du 23/09. « Personne n'est prévenu » est un RÉGLAGE : des gens
       * peuvent valider, mais tous ont coupé l'avis. Les deux laissent la demande en plan, donc
       * les deux s'écrivent au centre d'alerte ; les confondre enverrait chercher la panne au
       * mauvais endroit.
       */
      const possibles = await this.destinataires.possibles(input.fleetId);
      const validators = possibles.filter((v) => v.notifie);
      if (validators.length === 0) {
        const aucunValideur = possibles.length === 0;
        await this.errors.record(
          aucunValideur
            ? `Demande de réservation publique sans destinataire : aucun compte de cette société ne porte « reservations_manage ». La demande de ${input.requester} attend, personne n'est prévenu.`
            : `Demande de réservation publique sans destinataire : ${possibles.length} compte(s) peuvent valider, mais AUCUN ne reçoit l'avis (réglage « Paramètres de l'agenda »). La demande de ${input.requester} attend sans que personne ne le sache.`,
          SOURCE,
          { fleetId: input.fleetId, motif: aucunValideur ? 'aucun_valideur' : 'aucun_destinataire', valideurs: possibles.length },
          'ERROR',
        );
        return 0;
      }

      const slotLabel = this.fmtSlot(input.startAt, input.endAt);
      const built = this.email.buildReservationRequestPendingEmail({
        fleetName: await this.fleetNameOf(input.fleetId),
        requester: input.requester,
        contact: input.contact,
        slotLabel,
        destination: input.destination,
        seats: input.seats,
        childSeatsLabel: this.libelleSieges(input.childSeats),
        vehicleCount: input.vehicleCount,
        agendaUrl: `${(process.env.APP_BASE_URL || '').replace(/\/$/, '')}/agenda`,
      });

      let envoyes = 0;
      for (const v of validators) {
        if (!v.email) continue;
        try {
          const res = await this.email.send({
            to: v.email,
            subject: built.subject,
            html: built.html,
            text: built.text,
            template: 'reservation_request_pending',
            fleetId: input.fleetId,
            context: { kind: 'public_reservation_pending' },
          });
          if (res.ok) envoyes++;
          else {
            await this.errors.record(
              `Avis de demande à valider non remis : ${res.error ?? 'erreur inconnue'}`,
              SOURCE,
              { fleetId: input.fleetId, destinataire: this.mask(v.email) },
            );
          }
        } catch (e) {
          await this.errors.record(e instanceof Error ? e : String(e), SOURCE, {
            fleetId: input.fleetId,
            destinataire: this.mask(v.email),
          });
        }
      }

      // Socle générique : mêmes préférences, même anti-spam, même journal que toute notification.
      // `subjectKey` cloisonne le refroidissement par créneau — deux demandes pour le même créneau
      // se groupent, deux créneaux différents passent tous les deux.
      if (this.dispatch) {
        await this.dispatch
          .notifyUsers({
            userIds: validators.map((v) => v.id),
            category: 'SYSTEM',
            kind: 'reservation-request',
            subjectKey: `${input.fleetId}:${input.startAt}`,
            title: 'Demande de réservation à valider',
            body: `${input.requester} — ${slotLabel}${input.destination ? ` → ${input.destination}` : ''}`,
            url: '/agenda',
            fleetId: input.fleetId,
          })
          .catch(() => 0);
      }
      return envoyes;
    } catch (e) {
      await this.errors
        .record(e instanceof Error ? e : String(e), SOURCE, { fleetId: input.fleetId, motif: 'avis_valideurs' })
        .catch(() => undefined);
      return 0;
    }
  }

  // ─── Interne ───────────────────────────────────────────────────────────────

  /**
   * Les comptes ACTIFS de la société dont les permissions effectives portent `reservations_manage`.
   *
   * Effectif = défauts du rôle, recouverts par le JSON du compte — la même règle que partout
   * ailleurs. ⚠️ Une clé ABSENTE du JSON ne vaut pas `false` : elle vaut le défaut du rôle. Lire
   * le JSON seul ferait disparaître le fleet-admin, dont le JSON est souvent vide.
   */
  /**
   * Ceux à qui l'avis part réellement.
   *
   * ⚠️ La règle « qui peut valider / qui est prévenu » vit dans {@link DestinatairesAvisService},
   * côté agenda, parce que l'écran des réglages en a besoin AUSSI et que `ReservationBooking`
   * importe déjà `Agenda` — la mettre ici et la lire depuis l'agenda fermerait un cycle.
   */
  private async validatorsOf(fleetId: string): Promise<{ id: string; email: string | null }[]> {
    return this.destinataires.notifies(fleetId);
  }

  /** Nom de la flotte (pour l'e-mail). Best-effort → « la société » si indisponible. */
  private async fleetNameOf(fleetId: string): Promise<string> {
    try {
      const f = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { name: true } });
      return f?.name?.trim() || 'la société';
    } catch {
      return 'la société';
    }
  }

  /** Envoie e-mail (contact avec « @ ») ou SMS. Tout échec → centre d'alerte admin. */
  private async notify(
    contact: string,
    fleetId: string,
    built: { subject: string; text: string; html: string },
    template: EmailTemplateId,
  ): Promise<void> {
    const c = (contact || '').trim();
    if (!c) return;
    const isEmail = c.includes('@');
    try {
      const res = isEmail
        ? await this.email.send({ to: c, subject: built.subject, html: built.html, text: built.text, template, fleetId, context: { kind: 'public_reservation' } })
        : await this.sms.send(c, built.text, { template: 'reservation_public', kind: 'public_reservation', fleetId });
      if (!res.ok) {
        await this.errors.record(
          `Notification demandeur échouée (${isEmail ? 'e-mail' : 'SMS'}) : ${res.error ?? 'erreur inconnue'}`,
          SOURCE,
          { fleetId, channel: isEmail ? 'email' : 'sms', contact: this.mask(c) },
        );
      }
    } catch (e) {
      await this.errors.record(
        e instanceof Error ? e : String(e),
        SOURCE,
        { fleetId, channel: isEmail ? 'email' : 'sms', contact: this.mask(c) },
      );
    }
  }

  /** « 1 bébé · 2 enfant » — les sièges auto demandés, ou null s'il n'y en a pas. */
  private libelleSieges(c: { baby: number; child: number } | null | undefined): string | null {
    if (!c) return null;
    const parts = [c.baby > 0 ? `${c.baby} bébé` : '', c.child > 0 ? `${c.child} enfant` : ''].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  }

  /**
   * Créneau lisible (Europe/Paris) pour l'e-mail / SMS. Une fin un AUTRE jour porte sa date
   * (contre-revue du 29/09) : « lundi 09:00 → 00:00 » pour une réservation qui garde sa voiture
   * jusqu'à jeudi disait l'inverse de la réalité.
   */
  private fmtSlot(startAtIso: string, endAtIso: string | null): string {
    try {
      const complet = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      });
      const jour = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
      const s = complet.format(new Date(startAtIso));
      if (!endAtIso) return s;
      const memeJour = jour.format(new Date(startAtIso)) === jour.format(new Date(endAtIso));
      const e = memeJour
        ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(endAtIso))
        : complet.format(new Date(endAtIso));
      return `${s} → ${e}`;
    } catch {
      return startAtIso;
    }
  }

  /** Masque le contact pour la journalisation (RGPD : pas de PII en clair dans les alertes). */
  private mask(c: string): string {
    if (c.includes('@')) {
      const [u, d] = c.split('@');
      return `${(u ?? '').slice(0, 2)}***@${d ?? ''}`;
    }
    return c.length > 4 ? `${c.slice(0, 3)}***${c.slice(-2)}` : '***';
  }
}
