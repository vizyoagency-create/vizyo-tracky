import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MissionRequestStatus, MissionStopKind, Prisma, QuoteRoundAuthor, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { NO_FLEET, requiredFleetScope } from '../common/tenant-scope';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { MissionPricingService, type ResultatTarif } from './mission-pricing.service';
import { MissionsService } from './missions.service';

/**
 * Espace depot, lot A6 — les demandes de mission et leur negociation.
 * Cf. docs/A6-DEMANDES-ET-DEVIS.md.
 *
 * ┌─ L'INVARIANT QUI TIENT TOUT LE RESTE ─────────────────────────────────────┐
 * │ UNE DEMANDE N'EST PAS UNE MISSION.                                        │
 * │                                                                            │
 * │ Elle n'immobilise aucun vehicule, ne pose aucun evenement d'agenda, n'ouvre │
 * │ aucun acces a une position. Aucun code de ce service ne touche a           │
 * │ `vehicleEvent`, ni a `Mission`, sauf a la conversion — et la conversion    │
 * │ passe par `MissionsService.creer`, le chemin existant, avec ses sept       │
 * │ validations et ses quatre effets de bord.                                  │
 * │                                                                            │
 * │ Tant que les deux parties n'ont pas signe, rien n'existe cote exploitation.│
 * └────────────────────────────────────────────────────────────────────────────┘
 */

export interface ArretEntree {
  kind?: 'PICKUP' | 'DROPOFF';
  label: string;
  placeId?: string | null;
  lat?: number | null;
  lng?: number | null;
  wantedAt?: string | null;
  note?: string | null;
}

export interface DemandeEntree {
  fleetId?: string | null;
  stops: ArretEntree[];
  wantedStartAt: string;
  wantedEndAt: string;
  goodsDescription?: string | null;
  weightKg?: number | null;
  /** Distance annoncee par le depot, en KILOMETRES (l'ecran parle en km). */
  declaredDistanceKm?: number | null;
  message?: string | null;
}

/** Les conditions d'un tour, figees. Cf. `MissionQuoteRound.terms`. */
export interface ConditionsTour {
  stops: Array<{ position: number; kind: string; label: string; wantedAt: string | null }>;
  wantedStartAt: string;
  wantedEndAt: string;
  usedDistanceKm: number | null;
}

export interface TourEntree {
  /** Montant propose, en CENTIMES. `null` = « je ne chiffre pas » (sur devis). */
  amountCents?: number | null;
  message?: string | null;
  /** Conditions modifiees. Absentes = on reprend celles du tour precedent. */
  stops?: ArretEntree[];
  wantedStartAt?: string;
  wantedEndAt?: string;
  usedDistanceKm?: number | null;
}

/**
 * Qui doit recevoir l'avis.
 *
 * `LES_DEUX` n'est pas un raccourci : l'accord conclu est le seul moment ou les deux
 * cotes de la table apprennent la MEME chose au MEME instant. Prevenir une seule
 * partie ferait attendre l'autre sans qu'elle sache qu'on l'attend.
 */
type Destinataire = 'DEPOT' | 'CARRIER' | 'LES_DEUX';

/** Statuts ou une demande est encore VIVANTE : elle attend une reponse. */
const EN_COURS: MissionRequestStatus[] = [
  MissionRequestStatus.SUBMITTED,
  MissionRequestStatus.NEGOTIATING,
];

@Injectable()
export class MissionRequestsService {
  private readonly logger = new Logger(MissionRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: MissionPricingService,
    /** La conversion passe par le chemin EXISTANT, jamais par un mission.create maison. */
    private readonly missions: MissionsService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ═══ CREATION ═══════════════════════════════════════════════════════════════

  /**
   * Cree la demande ET son devis, en une fois.
   *
   * Le client veut un devis « des la demande » (arbitrage D) : le tour 0 est donc
   * ecrit ici, auteur SYSTEM, avec le detail du calcul FIGE. Une grille modifiee
   * demain ne reecrira pas une offre deja lue.
   *
   * Quand la distance depasse la derniere tranche chiffree, le tour 0 existe QUAND
   * MEME mais sans montant : « sur devis » est un etat, pas un prix, et la demande
   * doit partir avec ses conditions meme sans chiffre.
   */
  async creer(user: AuthUser, entree: DemandeEntree) {
    const fleetId = this.porteeEcriture(user, entree.fleetId ?? undefined);
    const arrets = this.validerArrets(entree.stops);
    const { debut, fin } = this.validerCreneau(entree.wantedStartAt, entree.wantedEndAt);

    // ⚠️ La grille conditionne la DEMANDE, pas la mission (arbitrage J). Sans tarif,
    // il n'y a rien a presenter au depot : on refuse ici plutot que de le laisser
    // saisir dix adresses pour rien.
    const distanceM = this.kmVersMetres(entree.declaredDistanceKm);
    const tarif = await this.pricing.tarifPour(fleetId, distanceM ?? 0);
    if (tarif.statut === 'PAS_DE_GRILLE') {
      throw new BadRequestException(
        'Le transporteur n\'a pas encore publié ses tarifs : la demande de mission est indisponible.',
      );
    }

    const demande = await this.prisma.$transaction(async (tx) => {
      const ref = await this.genererReference(tx, fleetId);
      const creee = await tx.missionRequest.create({
        data: {
          ref,
          fleetId,
          depotUserId: user.id,
          status: MissionRequestStatus.SUBMITTED,
          wantedStartAt: debut,
          wantedEndAt: fin,
          goodsDescription: entree.goodsDescription ?? null,
          weightKg: entree.weightKg ?? null,
          declaredDistanceM: distanceM,
          usedDistanceM: distanceM,
          quoteExpiresAt: await this.echeanceDevis(fleetId),
          stops: {
            create: arrets.map((a, i) => ({
              position: i,
              kind: i === 0 ? MissionStopKind.PICKUP : MissionStopKind.DROPOFF,
              label: a.label,
              placeId: a.placeId ?? null,
              lat: a.lat ?? null,
              lng: a.lng ?? null,
              wantedAt: a.wantedAt ? new Date(a.wantedAt) : null,
              note: a.note ?? null,
            })),
          },
        },
        include: { stops: { orderBy: { position: 'asc' } } },
      });

      await tx.missionQuoteRound.create({
        data: {
          requestId: creee.id,
          position: 0,
          author: QuoteRoundAuthor.SYSTEM,
          amountCents: tarif.statut === 'TARIF' ? tarif.htCents : null,
          breakdown: this.detail(tarif),
          terms: this.conditions(creee) as unknown as Prisma.InputJsonValue,
          message: entree.message?.trim() || null,
        },
      });

      return creee;
    });

    this.logger.log(
      `Demande ${demande.ref} creee par ${user.id} — ${arrets.length} arret(s), ${tarif.statut}`,
    );
    void this.notifier(demande.id, 'CARRIER',
      'Nouvelle demande de mission',
      'Un de vos dépôts vous adresse une demande. Le devis ci-dessous a été calculé sur votre grille tarifaire.',
      'Ouvrir la demande');
    return this.detailComplet(demande.id);
  }

  // ═══ NEGOCIATION ════════════════════════════════════════════════════════════

  /**
   * Un tour de plus : contre-proposition de l'une ou l'autre partie.
   *
   * Le tour porte les conditions COMPLETES qu'il propose (arbitrage I) : adresses,
   * creneau, distance. Accepter, c'est accepter UNE VERSION PRECISE — un accord sur
   * un prix dont les conditions ont bouge entre-temps n'est pas un accord.
   *
   * ⚠️ ON NE PEUT PAS REPONDRE A SOI-MEME. L'auteur du dernier tour est celui qui
   * attend : lui laisser enchainer deux offres transformerait la negociation en
   * monologue, et le destinataire ne saurait plus a quoi il repond.
   */
  async contreProposer(user: AuthUser, requestId: string, entree: TourEntree) {
    const demande = await this.chargerAccessible(user, requestId);
    if (!EN_COURS.includes(demande.status)) {
      throw new BadRequestException(
        `Cette demande est ${this.libelleStatut(demande.status)} : elle ne se négocie plus.`,
      );
    }

    const roleDansLaNegociation = this.camp(user, demande);
    const dernier = demande.rounds[demande.rounds.length - 1];
    // Meme regle qu'a l'acceptation : le tour 0 (SYSTEM) est l'offre du depot. Sans
    // `campDuTour`, il pouvait enchainer une contre-proposition sur son propre devis
    // avant meme que le transporteur l'ait lu — un monologue, pas une negociation.
    if (dernier && this.campDuTour(dernier.author) === roleDansLaNegociation) {
      throw new BadRequestException(
        'Vous avez déjà la main : attendez la réponse de l\'autre partie.',
      );
    }

    // Les conditions changent, ou pas. Absentes, on reprend celles en cours.
    const arrets = entree.stops ? this.validerArrets(entree.stops) : null;
    const creneau =
      entree.wantedStartAt && entree.wantedEndAt
        ? this.validerCreneau(entree.wantedStartAt, entree.wantedEndAt)
        : null;
    const distanceM =
      entree.usedDistanceKm !== undefined
        ? this.kmVersMetres(entree.usedDistanceKm)
        : demande.usedDistanceM;

    // Le prix est RECALCULE sur les nouvelles conditions, puis reste ajustable
    // (arbitrage I) : si l'auteur propose un montant, c'est le sien qui compte.
    const tarif = await this.pricing.tarifPour(demande.fleetId, distanceM ?? 0);
    const montant =
      entree.amountCents !== undefined && entree.amountCents !== null
        ? Math.round(entree.amountCents)
        : tarif.statut === 'TARIF'
          ? tarif.htCents
          : null;
    if (montant !== null && montant < 0) {
      throw new BadRequestException('Un montant ne peut pas être négatif.');
    }

    await this.prisma.$transaction(async (tx) => {
      if (arrets) {
        await tx.missionStop.deleteMany({ where: { requestId } });
        await tx.missionStop.createMany({
          data: arrets.map((a, i) => ({
            requestId,
            position: i,
            kind: i === 0 ? MissionStopKind.PICKUP : MissionStopKind.DROPOFF,
            label: a.label,
            placeId: a.placeId ?? null,
            lat: a.lat ?? null,
            lng: a.lng ?? null,
            wantedAt: a.wantedAt ? new Date(a.wantedAt) : null,
            note: a.note ?? null,
          })),
        });
      }

      const misAJour = await tx.missionRequest.update({
        where: { id: requestId },
        data: {
          status: MissionRequestStatus.NEGOTIATING,
          ...(creneau ? { wantedStartAt: creneau.debut, wantedEndAt: creneau.fin } : {}),
          usedDistanceM: distanceM,
        },
        include: { stops: { orderBy: { position: 'asc' } } },
      });

      await tx.missionQuoteRound.create({
        data: {
          requestId,
          position: demande.rounds.length,
          author: roleDansLaNegociation,
          authorUserId: user.id,
          amountCents: montant,
          breakdown: this.detail(tarif),
          terms: this.conditions(misAJour) as unknown as Prisma.InputJsonValue,
          message: entree.message?.trim() || null,
        },
      });
    });

    this.logger.log(
      `Demande ${demande.ref} — tour ${demande.rounds.length} par ${roleDansLaNegociation}`,
    );
    void this.notifier(
      requestId,
      // L'AUTRE camp que celui qui vient de jouer : c'est lui qui doit repondre.
      roleDansLaNegociation === QuoteRoundAuthor.DEPOT ? 'CARRIER' : 'DEPOT',
      'Nouvelle proposition',
      "L'autre partie vous a répondu. Voici sa proposition.",
      'Voir la proposition',
    );
    return this.detailComplet(requestId);
  }

  /**
   * Accepter le dernier tour.
   *
   * ⚠️ ON N'ACCEPTE PAS SA PROPRE OFFRE. Sans cette garde, une partie validerait
   * seule et la demande passerait en ACCEPTED sans que l'autre ait rien dit — un
   * accord a une seule signature.
   */
  async accepter(user: AuthUser, requestId: string) {
    const demande = await this.chargerAccessible(user, requestId);
    if (!EN_COURS.includes(demande.status)) {
      throw new BadRequestException(
        `Cette demande est ${this.libelleStatut(demande.status)} : elle ne s'accepte plus.`,
      );
    }
    const dernier = demande.rounds[demande.rounds.length - 1];
    if (!dernier) throw new BadRequestException('Cette demande ne porte aucune offre.');

    const camp = this.camp(user, demande);
    // ⚠️ `campDuTour`, et NON `dernier.author` : sans lui, le depot acceptait son
    // propre devis automatique (auteur SYSTEM) dans la seconde suivant l'envoi, et la
    // demande passait en ACCEPTED sans que le transporteur ait rien dit.
    if (this.campDuTour(dernier.author) === camp) {
      throw new BadRequestException(
        'Vous ne pouvez pas accepter votre propre proposition : elle attend l\'autre partie.',
      );
    }
    if (dernier.amountCents === null) {
      throw new BadRequestException(
        'Cette offre est « sur devis » : le transporteur doit d\'abord proposer un montant.',
      );
    }

    await this.prisma.missionRequest.update({
      where: { id: requestId },
      data: {
        status: MissionRequestStatus.ACCEPTED,
        agreedAmountCents: dernier.amountCents,
        agreedAt: new Date(),
      },
    });
    this.logger.log(`Demande ${demande.ref} acceptee par ${camp} — ${dernier.amountCents} centimes`);
    // ⚠️ AUX DEUX PARTIES, et c'est le seul avis du lot dans ce cas.
    //
    // Les trois autres previennent celui qui doit repondre. Ici plus personne ne doit
    // repondre : l'un vient de signer, l'autre ne sait pas encore qu'on a signe. Ne
    // prevenir que le transporteur laisserait le depot devant une demande « en
    // negociation » qui ne bouge plus, sans comprendre qu'elle est conclue et qu'il
    // n'attend plus qu'un camion.
    void this.notifier(
      requestId,
      'LES_DEUX',
      'Accord conclu',
      'Les deux parties se sont accordées sur le montant ci-dessous. Le transporteur affecte à présent un véhicule et un conducteur.',
      'Voir la demande',
    );
    return this.detailComplet(requestId);
  }

  /** Refuser, avec motif. Sans motif, l'autre partie repose la meme demande. */
  async refuser(user: AuthUser, requestId: string, motif: string) {
    const demande = await this.chargerAccessible(user, requestId);
    if (!EN_COURS.includes(demande.status)) {
      throw new BadRequestException(
        `Cette demande est ${this.libelleStatut(demande.status)} : elle ne se refuse plus.`,
      );
    }
    const propre = (motif ?? '').trim();
    if (propre.length < 3) {
      throw new BadRequestException('Un motif de refus est obligatoire.');
    }
    await this.prisma.missionRequest.update({
      where: { id: requestId },
      data: {
        status: MissionRequestStatus.REJECTED,
        rejectedAt: new Date(),
        rejectedReason: propre,
        rejectedBy: this.camp(user, demande),
      },
    });
    return this.detailComplet(requestId);
  }

  // ═══ AFFECTATION ET CONVERSION (T7) ═════════════════════════════════════════

  /**
   * Affecter un camion et un conducteur : la demande devient une MISSION.
   *
   * ┌─ C'EST ICI, ET SEULEMENT ICI, QUE L'EXPLOITATION COMMENCE ────────────────┐
   * │ Jusqu'a cet appel, rien n'existait cote flotte. A partir de lui : le      │
   * │ vehicule est immobilise, un evenement d'agenda est pose, le depot recoit  │
   * │ un acces a la position pendant la fenetre. Les quatre effets de bord de   │
   * │ `MissionsService.creer`.                                                  │
   * │                                                                            │
   * │ On passe par CE service-la, jamais par un `mission.create` maison : ses    │
   * │ sept validations (creneau, chevauchement, depot de la flotte, conducteur   │
   * │ de la flotte…) sont exactement celles qu'une demande negociee doit encore  │
   * │ franchir. Une demande acceptee n'est pas une mission valide — le camion    │
   * │ choisi peut avoir ete pris entre-temps.                                    │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * Reserve au TRANSPORTEUR : c'est lui qui engage son parc. Un depot qui
   * tenterait l'appel est arrete ici, avant toute ecriture.
   */
  async affecter(
    user: AuthUser,
    requestId: string,
    entree: { vehicleId: string; driverId?: string | null; notes?: string | null },
  ) {
    if (user.role === UserRole.DEPOT) {
      throw new ForbiddenException(
        'Seul le transporteur affecte un véhicule : c\'est son parc qu\'il engage.',
      );
    }
    const demande = await this.chargerAccessible(user, requestId);
    if (demande.status !== MissionRequestStatus.ACCEPTED) {
      throw new BadRequestException(
        `Cette demande est ${this.libelleStatut(demande.status)} : elle ne peut pas être affectée tant que les deux parties ne se sont pas accordées.`,
      );
    }
    if (demande.missionId) {
      throw new BadRequestException('Cette demande a déjà donné lieu à une mission.');
    }
    if (!entree?.vehicleId) {
      throw new BadRequestException('Choisissez un véhicule.');
    }

    // Les deux libelles de la mission se composent depuis le PREMIER et le DERNIER
    // arret. `Mission` reste point a point ; les arrets, eux, sont reportes tels
    // quels juste apres, et deviennent la source de verite du trajet.
    const arrets = [...demande.stops].sort((a, b) => a.position - b.position);
    const depart = arrets[0];
    const arrivee = arrets[arrets.length - 1];

    const { mission, avertissements } = await this.missions.creer(
      user,
      {
        fleetId: demande.fleetId,
        vehicleId: entree.vehicleId,
        driverId: entree.driverId ?? null,
        depotUserId: demande.depotUserId,
        originLabel: depart.label,
        destLabel: arrivee.label,
        startAt: demande.wantedStartAt.toISOString(),
        endAt: demande.wantedEndAt.toISOString(),
        notes: entree.notes ?? null,
      },
      // L'avis generique de creation de mission est COUPE ici, et remplace juste apres
      // par celui qui nomme la demande negociee. Les deux partiraient dans la meme
      // seconde pour un seul evenement, et le premier ignore tout de la negociation :
      // le depot lirait « mission M-2481 » sans jamais retrouver sa demande D-0142.
      { notifierDepot: false },
    );

    await this.prisma.$transaction(async (tx) => {
      // Les arrets sont COPIES sur la mission, pas deplaces : la demande garde les
      // siens, sans quoi son historique de negociation deviendrait illisible — on ne
      // saurait plus sur quel trajet les parties se sont accordees.
      await tx.missionStop.createMany({
        data: arrets.map((a) => ({
          missionId: mission.id,
          position: a.position,
          kind: a.kind,
          label: a.label,
          placeId: a.placeId,
          lat: a.lat,
          lng: a.lng,
          wantedAt: a.wantedAt,
          note: a.note,
        })),
      });
      await tx.missionRequest.update({
        where: { id: requestId },
        data: { status: MissionRequestStatus.CONVERTED, missionId: mission.id },
      });
    });

    this.logger.log(
      `Demande ${demande.ref} convertie en mission ${mission.ref} — ${arrets.length} arret(s)`,
    );
    // Le moment que le depot attend depuis sa premiere saisie. L'avis nomme LES DEUX
    // references : sans la sienne, il lit « mission M-2481 » sans pouvoir la relier a
    // la demande qu'il a negociee, et sans savoir si son autre demande est passee.
    void this.notifier(
      requestId,
      'DEPOT',
      'Votre demande est confirmée',
      `Un véhicule est affecté : votre demande devient la mission ${mission.ref}. Vous suivrez sa position depuis votre espace le jour venu.`,
      'Suivre la mission',
    );
    return { mission, avertissements, request: await this.detailComplet(requestId) };
  }

  // ═══ LECTURE ════════════════════════════════════════════════════════════════

  /**
   * La liste. Un depot ne voit QUE les siennes — verifie a chaque requete, jamais
   * depuis un champ de session.
   */
  async lister(user: AuthUser, fleetIdDemande?: string, statut?: MissionRequestStatus) {
    const estDepot = user.role === UserRole.DEPOT;
    const portee = requiredFleetScope(user, fleetIdDemande);

    const demandes = await this.prisma.missionRequest.findMany({
      where: {
        ...(estDepot ? { depotUserId: user.id } : portee ? { fleetId: portee } : {}),
        ...(statut ? { status: statut } : {}),
      },
      include: {
        stops: { orderBy: { position: 'asc' } },
        rounds: { orderBy: { position: 'asc' } },
        depotUser: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return demandes.map((d) => this.versDto(d));
  }

  /**
   * La grille tarifaire de la societe du depot, pour l'apercu de saisie.
   *
   * Un depot n'a AUCUNE portee choisie : c'est celle de son compte, jamais une
   * demandee. `porteeEcriture` porte deja cette regle — on la reutilise plutot que
   * de la recopier, parce qu'une portee recopiee finit par diverger.
   *
   * `null` quand aucune grille n'existe : un cas NORMAL, que l'ecran traduit en
   * « le transporteur n'a pas publie ses tarifs » plutot qu'en panne.
   */
  async grilleApplicable(user: AuthUser) {
    const fleetId = this.porteeEcriture(user);
    return this.pricing.lire(user, fleetId);
  }

  /**
   * Le detail, APRES verification d'acces.
   *
   * C'est ce point d'entree que les controleurs emploient — jamais `detailComplet`
   * seul, qui ne verifie rien et sert aux retours internes apres une ecriture deja
   * autorisee.
   */
  async detailPour(user: AuthUser, requestId: string) {
    await this.chargerAccessible(user, requestId);
    return this.detailComplet(requestId);
  }

  async detailComplet(requestId: string) {
    const d = await this.prisma.missionRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: {
        stops: { orderBy: { position: 'asc' } },
        rounds: { orderBy: { position: 'asc' } },
        depotUser: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    return this.versDto(d);
  }

  // ═══ NOTIFICATIONS ══════════════════════════════════════════════════════════

  /**
   * Prevenir l'autre partie qu'une offre l'attend.
   *
   * ┌─ HORS TRANSACTION, ET VOLONTAIREMENT ─────────────────────────────────────┐
   * │ Un e-mail qui echoue ne doit pas annuler une negociation deja ecrite. Les  │
   * │ deux parties verront la demande en se connectant de toute facon ; l'e-mail │
   * │ est un rappel, pas le canal de verite. Meme raisonnement que               │
   * │ `MissionsService.notifierDepot`.                                          │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * Pendant la negociation, le destinataire est L'AUTRE CAMP : le depot a repondu, on
   * previent le transporteur, et inversement. On ne se previent jamais soi-meme. A
   * l'accord, `LES_DEUX` : c'est le seul moment ou les deux cotes apprennent la meme
   * chose au meme instant.
   *
   * ┌─ UN SEUL GABARIT POUR LES DEUX SENS, ET C'EST DELIBERE ───────────────────┐
   * │ `buildMissionQuoteEmail` sert les quatre avis du lot — demande, contre-    │
   * │ proposition, accord, affectation. Ce qui change d'un cote a l'autre, c'est │
   * │ le LIEN : le depot ouvre sa demande dans son espace, le transporteur       │
   * │ l'ouvre dans sa file. Deux gabarits auraient diverge des la premiere        │
   * │ retouche, et le depot aurait fini par recevoir une mise en page differente │
   * │ selon l'expediteur du meme fil de discussion.                              │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  private async notifier(
    requestId: string,
    cible: Destinataire,
    titre: string,
    intro: string,
    libelleAction: string,
  ): Promise<void> {
    try {
      const d = await this.prisma.missionRequest.findUnique({
        where: { id: requestId },
        include: {
          stops: { orderBy: { position: 'asc' } },
          rounds: { orderBy: { position: 'desc' }, take: 1 },
          depotUser: { select: { email: true } },
          fleet: { select: { name: true } },
        },
      });
      if (!d) return;

      const base = this.config.get('APP_BASE_URL', { infer: true }) ?? '';

      // Chaque cote a SES adresses et SON lien. Vers le DEPOT : une seule adresse.
      // Vers le TRANSPORTEUR : tous ceux qui gerent les missions de la societe — un
      // seul destinataire nomme se serait trouve en conges le jour ou une demande
      // arrive.
      const cotes: Array<{ emails: string[]; url: string }> = [];
      if (cible === 'DEPOT' || cible === 'LES_DEUX') {
        cotes.push({ emails: [d.depotUser.email], url: `${base}/depot/requests/${d.id}` });
      }
      if (cible === 'CARRIER' || cible === 'LES_DEUX') {
        const gestionnaires = await this.prisma.user.findMany({
          where: {
            fleetId: d.fleetId,
            isActive: true,
            role: { in: [UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER] },
          },
          select: { email: true },
        });
        cotes.push({ emails: gestionnaires.map((u) => u.email), url: `${base}/missions?demande=${d.id}` });
      }

      const dernier = d.rounds[0];
      for (const cote of cotes) {
        if (cote.emails.length === 0) continue;
        const tpl = this.email.buildMissionQuoteEmail({
          ref: d.ref,
          titre,
          intro,
          origin: d.stops[0]?.label ?? '',
          destination: d.stops[d.stops.length - 1]?.label ?? '',
          nbArrets: d.stops.length,
          startAt: d.wantedStartAt,
          endAt: d.wantedEndAt,
          amountCents: dernier?.amountCents ?? null,
          message: dernier?.message ?? null,
          // Le nom du TRANSPORTEUR, pas Tracky : c'est de lui que le depot attend un
          // e-mail (A0 § Marque).
          carrierName: d.fleet?.name ?? 'Votre transporteur',
          url: cote.url,
          libelleAction,
        });

        for (const to of cote.emails) {
          await this.email.send({
            to,
            subject: tpl.subject,
            html: tpl.html,
            text: tpl.text,
            template: 'mission_request',
            context: { requestId: d.id, fleetId: d.fleetId },
          });
        }
      }
    } catch (err) {
      // Journalise et continue : la negociation est ecrite, elle ne doit pas
      // dependre d'un serveur de messagerie.
      this.logger.warn(`Notification de la demande ${requestId} en échec : ${String(err)}`);
    }
  }

  // ═══ OUTILS ═════════════════════════════════════════════════════════════════

  /**
   * Charge la demande SI l'appelant y a droit.
   *
   * Un depot ne touche que les siennes ; un transporteur, que celles de sa societe.
   * Le meme message dans les deux cas d'echec : distinguer « inexistante » de « pas
   * a vous » permettrait de sonder l'existence d'une demande par son identifiant.
   */
  private async chargerAccessible(user: AuthUser, requestId: string) {
    const estDepot = user.role === UserRole.DEPOT;
    const portee = requiredFleetScope(user);
    const demande = await this.prisma.missionRequest.findFirst({
      where: {
        id: requestId,
        ...(estDepot ? { depotUserId: user.id } : portee ? { fleetId: portee } : {}),
      },
      include: { stops: { orderBy: { position: 'asc' } }, rounds: { orderBy: { position: 'asc' } } },
    });
    if (!demande) throw new NotFoundException('Demande introuvable');
    return demande;
  }

  /** De quel cote de la table se trouve l'appelant. */
  private camp(user: AuthUser, demande: { depotUserId: string }): QuoteRoundAuthor {
    return user.role === UserRole.DEPOT && user.id === demande.depotUserId
      ? QuoteRoundAuthor.DEPOT
      : QuoteRoundAuthor.CARRIER;
  }

  /**
   * A QUEL CAMP APPARTIENT UN TOUR — et `SYSTEM` appartient au DEPOT.
   *
   * ┌─ LE TOUR 0 EST L'OFFRE DU DEPOT, PAS UN TIERS NEUTRE ─────────────────────┐
   * │ Le devis automatique est calcule A LA DEMANDE DU DEPOT, sur les conditions │
   * │ qu'il vient de saisir (arbitrage D). Il porte l'auteur `SYSTEM` parce que  │
   * │ personne ne l'a tape — mais il est du COTE du depot : c'est ce que celui-ci│
   * │ propose, et c'est au transporteur d'y repondre.                            │
   * │                                                                            │
   * │ Le traiter comme un camp a part avait deux consequences, decouvertes en    │
   * │ branchant les ecrans le 2026-08-14 :                                       │
   * │                                                                            │
   * │  1. `awaiting` valait `DEPOT` juste apres l'envoi. La file du transporteur │
   * │     n'aurait donc JAMAIS montre une demande neuve dans « a traiter » —     │
   * │     l'ecran entier serait passe a cote de son objet.                       │
   * │                                                                            │
   * │  2. Bien pire : `accepter` compare l'auteur du dernier tour au camp de     │
   * │     l'appelant. `SYSTEM` n'etant egal a aucun des deux, LE DEPOT POUVAIT   │
   * │     ACCEPTER SON PROPRE DEVIS AUTOMATIQUE dans la seconde qui suivait      │
   * │     l'envoi. La demande passait en `ACCEPTED` avec un montant convenu,     │
   * │     sans que le transporteur ait rien dit — un accord a une seule          │
   * │     signature, exactement ce que la garde etait censee empecher.           │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  private campDuTour(auteur: QuoteRoundAuthor): QuoteRoundAuthor {
    return auteur === QuoteRoundAuthor.CARRIER
      ? QuoteRoundAuthor.CARRIER
      : QuoteRoundAuthor.DEPOT;
  }

  /**
   * Les arrets, verifies. Un enlevement, au moins une livraison, pas de maximum.
   * Le retour au depot est une livraison COMME UNE AUTRE — jamais ajoute d'office
   * (arbitrage H).
   */
  private validerArrets(stops: ArretEntree[]): ArretEntree[] {
    if (!Array.isArray(stops) || stops.length < 2) {
      throw new BadRequestException(
        'Une demande comporte au moins une adresse de chargement et une adresse de livraison.',
      );
    }
    stops.forEach((a, i) => {
      if (!a?.label || !a.label.trim()) {
        throw new BadRequestException(`Adresse ${i + 1} : le libellé est obligatoire.`);
      }
    });
    return stops.map((a) => ({ ...a, label: a.label.trim() }));
  }

  private validerCreneau(debutIso: string, finIso: string): { debut: Date; fin: Date } {
    const debut = new Date(debutIso);
    const fin = new Date(finIso);
    if (Number.isNaN(debut.getTime()) || Number.isNaN(fin.getTime())) {
      throw new BadRequestException('Dates invalides');
    }
    if (fin.getTime() <= debut.getTime()) {
      throw new BadRequestException('L\'heure de fin doit suivre l\'heure de départ.');
    }
    return { debut, fin };
  }

  /** Les kilometres de l'ecran deviennent des metres entiers en base. */
  private kmVersMetres(km: number | null | undefined): number | null {
    if (km === null || km === undefined) return null;
    if (!Number.isFinite(km) || km < 0) {
      throw new BadRequestException('La distance doit être un nombre positif.');
    }
    return Math.round(km * 1000);
  }

  private async echeanceDevis(fleetId: string): Promise<Date | null> {
    const grille = await this.prisma.missionPricingSettings.findUnique({
      where: { fleetId },
      select: { quoteValidityHours: true },
    });
    if (!grille) return null;
    return new Date(Date.now() + grille.quoteValidityHours * 3600_000);
  }

  /** Le detail du calcul, tel qu'il est fige dans le tour. */
  private detail(tarif: ResultatTarif): Prisma.InputJsonValue {
    if (tarif.statut !== 'TARIF') {
      return { statut: tarif.statut, motif: 'motif' in tarif ? tarif.motif : null };
    }
    return {
      statut: 'TARIF',
      trancheLibelle: tarif.trancheLibelle,
      distanceKm: tarif.distanceKm,
      htCents: tarif.htCents,
      tvaCents: tarif.tvaCents,
      ttcCents: tarif.ttcCents,
      lignes: tarif.lignes,
    };
  }

  /** Les conditions d'un tour, figees. */
  private conditions(d: {
    wantedStartAt: Date;
    wantedEndAt: Date;
    usedDistanceM: number | null;
    stops: Array<{ position: number; kind: string; label: string; wantedAt: Date | null }>;
  }): ConditionsTour {
    return {
      stops: d.stops.map((s) => ({
        position: s.position,
        kind: s.kind,
        label: s.label,
        wantedAt: s.wantedAt?.toISOString() ?? null,
      })),
      wantedStartAt: d.wantedStartAt.toISOString(),
      wantedEndAt: d.wantedEndAt.toISOString(),
      usedDistanceKm: d.usedDistanceM === null ? null : d.usedDistanceM / 1000,
    };
  }

  /**
   * Reference lisible, sequence par flotte : « D-0142 ».
   *
   * Distincte de celle des missions : un depot qui appelle doit pouvoir dire « ma
   * demande D-0142 » sans qu'on la confonde avec la mission M-0142 d'un autre client.
   */
  private async genererReference(tx: Prisma.TransactionClient, fleetId: string): Promise<string> {
    const dernier = await tx.missionRequest.findFirst({
      where: { fleetId },
      orderBy: { ref: 'desc' },
      select: { ref: true },
    });
    const numero = dernier ? Number(dernier.ref.replace('D-', '')) + 1 : 1;
    return `D-${String(numero).padStart(4, '0')}`;
  }

  private libelleStatut(s: MissionRequestStatus): string {
    const table: Record<MissionRequestStatus, string> = {
      DRAFT: 'un brouillon',
      SUBMITTED: 'envoyée',
      NEGOTIATING: 'en négociation',
      ACCEPTED: 'acceptée',
      CONVERTED: 'devenue une mission',
      REJECTED: 'refusée',
      EXPIRED: 'expirée',
    };
    return table[s];
  }

  private versDto(d: {
    id: string;
    ref: string;
    status: MissionRequestStatus;
    wantedStartAt: Date;
    wantedEndAt: Date;
    goodsDescription: string | null;
    weightKg: number | null;
    declaredDistanceM: number | null;
    usedDistanceM: number | null;
    agreedAmountCents: number | null;
    quoteExpiresAt: Date | null;
    rejectedReason: string | null;
    missionId: string | null;
    createdAt: Date;
    stops: Array<{ position: number; kind: string; label: string; wantedAt: Date | null; note: string | null }>;
    rounds: Array<{
      position: number; author: QuoteRoundAuthor; amountCents: number | null;
      breakdown: Prisma.JsonValue; message: string | null; createdAt: Date;
    }>;
    depotUser?: { id: string; firstName: string | null; lastName: string | null; email: string } | null;
  }) {
    const dernier = d.rounds[d.rounds.length - 1];
    return {
      id: d.id,
      ref: d.ref,
      status: d.status,
      wantedStartAt: d.wantedStartAt.toISOString(),
      wantedEndAt: d.wantedEndAt.toISOString(),
      goodsDescription: d.goodsDescription,
      weightKg: d.weightKg,
      declaredDistanceKm: d.declaredDistanceM === null ? null : d.declaredDistanceM / 1000,
      usedDistanceKm: d.usedDistanceM === null ? null : d.usedDistanceM / 1000,
      /** Le montant COURANT est le dernier tour — jamais un champ tenu en parallèle. */
      currentAmountCents: dernier?.amountCents ?? null,
      agreedAmountCents: d.agreedAmountCents,
      quoteExpiresAt: d.quoteExpiresAt?.toISOString() ?? null,
      rejectedReason: d.rejectedReason,
      missionId: d.missionId,
      createdAt: d.createdAt.toISOString(),
      /**
       * Qui doit répondre : l'autre camp que celui du dernier tour.
       *
       * ⚠️ `SYSTEM` compte pour le DÉPÔT (cf. `campDuTour`) : le devis automatique est
       * l'offre du dépôt, et c'est au transporteur d'y répondre. Une demande tout juste
       * envoyée attend donc le TRANSPORTEUR — sans quoi elle n'apparaîtrait jamais
       * dans sa file « à traiter ».
       */
      awaiting: dernier
        ? this.campDuTour(dernier.author) === QuoteRoundAuthor.DEPOT
          ? 'CARRIER'
          : 'DEPOT'
        : null,
      depot: d.depotUser
        ? {
            id: d.depotUser.id,
            nom: `${d.depotUser.firstName ?? ''} ${d.depotUser.lastName ?? ''}`.trim() || d.depotUser.email,
          }
        : null,
      stops: d.stops.map((s) => ({
        position: s.position,
        kind: s.kind,
        label: s.label,
        wantedAt: s.wantedAt?.toISOString() ?? null,
        note: s.note,
      })),
      rounds: d.rounds.map((r) => ({
        position: r.position,
        author: r.author,
        amountCents: r.amountCents,
        breakdown: r.breakdown,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  private porteeEcriture(user: AuthUser, fleetIdDemande?: string): string {
    // Un depot appartient a UNE societe : c'est la sienne, jamais une demandee.
    if (user.role === UserRole.DEPOT) {
      if (!user.fleetId) {
        throw new ForbiddenException('Votre compte dépôt n\'est rattaché à aucune société.');
      }
      return user.fleetId;
    }
    const id = requiredFleetScope(user, fleetIdDemande);
    if (!id) {
      throw new BadRequestException('Sélectionnez une société avant de déposer une demande.');
    }
    if (id === NO_FLEET) {
      throw new ForbiddenException('Aucune flotte associée à votre compte.');
    }
    return id;
  }
}
