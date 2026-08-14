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
import { PrismaService } from '../prisma/prisma.service';
import { MissionPricingService, type ResultatTarif } from './mission-pricing.service';

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
    if (dernier && dernier.author === roleDansLaNegociation) {
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

    this.logger.log(`Demande ${demande.ref} — tour ${demande.rounds.length} par ${roleDansLaNegociation}`);
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
    if (dernier.author === camp) {
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
      /** Qui doit répondre : l'autre camp que l'auteur du dernier tour. */
      awaiting: dernier
        ? dernier.author === QuoteRoundAuthor.DEPOT
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
