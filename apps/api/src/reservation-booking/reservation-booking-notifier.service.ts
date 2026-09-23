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

/**
 * Refonte agenda/IA (2026-07, P4) — Notifications au DEMANDEUR d'un lien public.
 * Découplé du flux réservation : à la SOUMISSION (accusé de réception) et à la VALIDATION
 * (`@OnEvent('reservation.confirmed')`). Canal : e-mail si le contact contient « @ », sinon SMS.
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
  }): Promise<void> {
    const built = this.email.buildReservationRequestedEmail({
      fleetName: await this.fleetNameOf(input.fleetId),
      slotLabel: this.fmtSlot(input.startAt, input.endAt),
      destination: input.destination,
      seats: input.seats ?? null,
    });
    await this.notify(input.contact, input.fleetId, built, 'reservation_requested');
  }

  /** Confirmation à la VALIDATION d'une réservation publique — e-mail AU THÈME. */
  @OnEvent('reservation.confirmed', { async: true })
  async onConfirmed(payload: {
    fleetId: string;
    vehiclePlate: string | null;
    startAt: string;
    endAt: string | null;
    metadata: Record<string, unknown> | null;
  }): Promise<void> {
    const m = payload?.metadata;
    if (!m || m['public'] !== true) return; // uniquement les demandes publiques
    const contact = typeof m['requesterContact'] === 'string' ? (m['requesterContact'] as string) : '';
    if (!contact.trim()) return;
    const built = this.email.buildReservationConfirmedEmail({
      fleetName: await this.fleetNameOf(payload.fleetId),
      slotLabel: this.fmtSlot(payload.startAt, payload.endAt),
      destination: typeof m['destination'] === 'string' ? (m['destination'] as string) : null,
      vehicle: payload.vehiclePlate,
    });
    await this.notify(contact, payload.fleetId, built, 'reservation_confirmed');
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

  /** Créneau lisible (Europe/Paris) pour l'e-mail / SMS. */
  private fmtSlot(startAtIso: string, endAtIso: string | null): string {
    try {
      const s = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      }).format(new Date(startAtIso));
      const e = endAtIso
        ? ' → ' + new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(endAtIso))
        : '';
      return s + e;
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
