import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type {
  ConfirmReservationDto,
  RequestReservationDto,
  SuggestReservationResultDto,
  SuggestedVehicleDto,
  UpdateReservationDto,
  VehicleEventDto,
  VehicleEventStatus as VehicleEventStatusDto,
} from '@vizyo/tracky-shared';
import { DORMANT_STOP_COUNTING_MS, effectiveBlockingEndMs, IMMOBILIZING_STATUSES, isVehicleDormant } from '@vizyo/tracky-shared';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { VehicleEventsService } from './vehicle-events.service';

type EventRow = Prisma.VehicleEventGetPayload<{ include: { vehicle: { select: { plate: true } } } }>;
const INCLUDE_PLATE = { vehicle: { select: { plate: true } } } as const;

/** Statuts « bloquants » : occupent le véhicule (conflits + disponibilité). */
const BLOCKING: VehicleEventStatus[] = [VehicleEventStatus.CONFIRMED, VehicleEventStatus.IN_PROGRESS];
/** Acteur « système » des réservations créées par l'agent (createdBy = colonne UUID sans FK User). */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
/**
 * Durée d'occupation MAXIMALE supposée d'un trajet encore ouvert (endedAt NULL). Un tel trajet
 * n'a pas de fin connue : on suppose qu'il dure au plus « une journée d'activité ». Il bloque donc
 * les créneaux PROCHES (véhicule qui roule) mais ni les créneaux LOINTAINS (sinon un véhicule qui
 * roule serait injustement injoignable pour la semaine prochaine), ni un trajet fantôme jamais
 * clôturé (au-delà de cette durée = anomalie tracker, ne bloque plus rien).
 */
const MAX_OPEN_TRIP_MS = 8 * 60 * 60 * 1000;
/** Fenêtre récente pour le tri par sous-utilisation (auto-complétion). */
const RECENT_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
const UNDERUTILIZED_RATIO = 0.12;

/**
 * Sprint 8 (Palier B) — Réservations de véhicules sur le modèle d'événement S7
 * (type=RESERVATION). Flux Demande → validation, scoping tenant STRICT (anti-IDOR,
 * chaîne S5), conflits gérés (pré-check 409 + contrainte EXCLUDE race-proof). La
 * prévision (S8 Palier C) reste dérivée et ne compte JAMAIS comme bloquante ici.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly events: VehicleEventsService,
    private readonly permissions: PermissionsResolverService,
    // EventEmitter2 global : injecté en prod, omis dans les specs. Déclenche l'agent sur une
    // réservation HUMAINE uniquement (jamais depuis systemConfirm/systemRequest → anti-boucle).
    private readonly emitter?: EventEmitter2,
  ) {}

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private parseSlot(startAt: string, endAt: string): { start: Date; end: Date } {
    const start = new Date(startAt);
    const end = new Date(endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Créneau invalide (dates ISO requises).');
    }
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException('La fin du créneau doit être après le début.');
    }
    return { start, end };
  }

  /** Coerce des critères (corps non typé à l'exécution) en valeurs sûres pour les requêtes. */
  private sanitizeCriteria(
    c: RequestReservationDto['criteria'] | undefined,
  ): { minSeats?: number; minChildSeats?: number; requiredFeatures?: string[] } {
    if (!c || typeof c !== 'object') return {};
    const minSeats = Number((c as { minSeats?: unknown }).minSeats);
    const minChildSeats = Number((c as { minChildSeats?: unknown }).minChildSeats);
    const rf = Array.isArray(c.requiredFeatures)
      ? c.requiredFeatures.filter((x): x is string => typeof x === 'string')
      : undefined;
    return {
      minSeats: Number.isFinite(minSeats) && minSeats > 0 ? Math.floor(minSeats) : undefined,
      minChildSeats: Number.isFinite(minChildSeats) && minChildSeats > 0 ? Math.floor(minChildSeats) : undefined,
      requiredFeatures: rf && rf.length > 0 ? rf : undefined,
    };
  }

  private async resolveScope(
    user: AuthUser,
    requestedFleetId?: string,
  ): Promise<{ fleetId?: string; ids: string[] | 'ALL' }> {
    let fleetId: string | undefined;
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associée');
      fleetId = user.fleetId;
      // Un non-super-admin ne peut jamais viser une autre société que la sienne.
      if (requestedFleetId && requestedFleetId !== user.fleetId) {
        throw new ForbiddenException('Flotte hors périmètre.');
      }
    } else if (requestedFleetId) {
      // SUPER_ADMIN : scoper sur la société demandée (filtre société global) au lieu de
      // balayer tout le parc de toutes les sociétés.
      fleetId = requestedFleetId;
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const ids = resolveReportVehicleScope(accessible, undefined);
    return { fleetId, ids };
  }

  /** Réservations FERMES (bloquantes) chevauchant [start,end) sur un véhicule. */
  async findOverlaps(vehicleId: string, start: Date, end: Date, excludeId?: string): Promise<EventRow[]> {
    return this.prisma.vehicleEvent.findMany({
      where: {
        vehicleId,
        type: VehicleEventType.RESERVATION,
        status: { in: BLOCKING },
        startAt: { lt: end },
        endAt: { gt: start },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      include: INCLUDE_PLATE,
    });
  }

  /**
   * Clause « trajet en cours » (endedAt NULL), bornée par une durée d'occupation max : un trajet
   * ouvert bloque un créneau qui commence dans (start − MAX_OPEN_TRIP_MS, end). Conséquences : un
   * véhicule qui roule MAINTENANT bloque bien les créneaux proches (même journée), mais pas ceux de
   * la semaine prochaine (sa fin n'est pas « infinie »), et un trajet jamais clôturé (démarré il y a
   * plus que cette durée = anomalie tracker) ne bloque plus rien.
   */
  private openTripOr(start: Date): Prisma.TripWhereInput[] {
    return [{ endedAt: null, startedAt: { gt: new Date(start.getTime() - MAX_OPEN_TRIP_MS) } }];
  }

  /** Un trajet RÉEL chevauche-t-il le créneau (véhicule effectivement pris) ? */
  private async hasTripOverlap(vehicleId: string, start: Date, end: Date): Promise<boolean> {
    const t = await this.prisma.trip.findFirst({
      where: { vehicleId, startedAt: { lt: end }, OR: [{ endedAt: { gt: start } }, ...this.openTripOr(start)] },
      select: { id: true },
    });
    return !!t;
  }

  /**
   * Véhicules immobilisés par un événement bloquant actif (incident/maintenance avec
   * `blocksVehicle`) chevauchant [start,end). Fin effective si endAt absent : un incident
   * bloque jusqu'à résolution, une maintenance all-day bloque sa journée.
   */
  private async findImmobilized(vehicleIds: string[], start: Date, end: Date): Promise<Set<string>> {
    const out = new Set<string>();
    if (vehicleIds.length === 0) return out;
    const rows = await this.prisma.vehicleEvent.findMany({
      where: {
        vehicleId: { in: vehicleIds },
        blocksVehicle: true,
        type: { not: VehicleEventType.RESERVATION },
        status: { in: IMMOBILIZING_STATUSES },
        startAt: { lt: end },
      },
      select: { vehicleId: true, type: true, startAt: true, endAt: true },
    });
    for (const r of rows) {
      // Source UNIQUE partagée avec le front (disponibilité affichée = ce que la résa accepte).
      const effectiveEnd = effectiveBlockingEndMs(r.type, r.startAt.getTime(), r.endAt ? r.endAt.getTime() : null);
      if (effectiveEnd > start.getTime()) out.add(r.vehicleId);
    }
    return out;
  }

  /** Charge une réservation en vérifiant le scope (flotte + périmètre véhicule). */
  private async loadScoped(user: AuthUser, id: string): Promise<EventRow> {
    const row = await this.prisma.vehicleEvent.findUnique({ where: { id }, include: INCLUDE_PLATE });
    if (!row) throw new NotFoundException('Réservation introuvable');
    if (user.role !== UserRole.SUPER_ADMIN && row.fleetId !== user.fleetId) {
      throw new NotFoundException('Réservation introuvable');
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    resolveReportVehicleScope(accessible, [row.vehicleId]); // 403 si hors périmètre
    if (row.type !== VehicleEventType.RESERVATION) {
      throw new BadRequestException("Cet événement n'est pas une réservation.");
    }
    return row;
  }

  private isExclusionConflict(err: unknown): boolean {
    // Code SQLSTATE fiable s'il est exposé (23P01 = exclusion_violation) ; sinon repli sur le
    // texte (nom de la contrainte / « exclusion constraint » dans le message Postgres).
    const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
    if (e?.code === '23P01' || e?.meta?.code === '23P01') return true;
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('no_overlap_reservation') ||
      msg.includes('23P01') ||
      msg.toLowerCase().includes('exclusion')
    );
  }

  private toDto(r: EventRow): VehicleEventDto {
    return {
      id: r.id,
      fleetId: r.fleetId,
      vehicleId: r.vehicleId,
      vehiclePlate: r.vehicle?.plate ?? null,
      type: r.type as VehicleEventDto['type'],
      category: r.category,
      status: r.status as VehicleEventStatusDto,
      severity: (r.severity as VehicleEventDto['severity']) ?? null,
      title: r.title,
      description: r.description,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt ? r.endAt.toISOString() : null,
      allDay: r.allDay,
      blocksVehicle: r.blocksVehicle,
      odometerKm: r.odometerKm,
      planId: r.planId,
      linkedEventId: r.linkedEventId,
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  // ─── Auto-complétion ──────────────────────────────────────────────────────

  async suggest(
    user: AuthUser,
    query: { startAt: string; endAt: string; criteria?: RequestReservationDto['criteria']; fleetId?: string },
  ): Promise<SuggestReservationResultDto> {
    const { start, end } = this.parseSlot(query.startAt, query.endAt);
    const scope = await this.resolveScope(user, query.fleetId);
    const where: Prisma.VehicleWhereInput = {};
    if (scope.fleetId) where.fleetId = scope.fleetId;
    if (scope.ids !== 'ALL') where.id = { in: scope.ids };
    return this.computeSuggestions(where, start, end, query.criteria);
  }

  /**
   * Disponibilité pour une flotte PRÉCISE (flux public P4, sans utilisateur authentifié).
   * `excludeRequested` : traite AUSSI les demandes en attente (REQUESTED) comme occupantes — un
   * demandeur public ne doit pas voir un véhicule déjà réservé NI déjà suggéré/demandé pour un autre.
   *
   * ⚠️ Le résultat porte les compteurs d'exclusion (dont `excludedDormant`) : ce sont des
   * informations INTERNES (état du parc). L'appelant public ne consomme que `vehicles` — ne jamais
   * remonter ces chiffres dans une réponse du lien public (anti-sondage de l'état de la flotte).
   */
  async availableForFleet(
    fleetId: string,
    startAt: string,
    endAt: string,
    criteria?: RequestReservationDto['criteria'],
    opts?: { excludeRequested?: boolean },
  ): Promise<SuggestReservationResultDto> {
    const { start, end } = this.parseSlot(startAt, endAt);
    return this.computeSuggestions({ fleetId }, start, end, criteria, opts);
  }

  /** Cœur d'auto-complétion : véhicules du `where` LIBRES sur [start,end) conformes aux critères. */
  private async computeSuggestions(
    where: Prisma.VehicleWhereInput,
    start: Date,
    end: Date,
    criteria?: RequestReservationDto['criteria'],
    opts?: { excludeRequested?: boolean },
  ): Promise<SuggestReservationResultDto> {
    const c = this.sanitizeCriteria(criteria);
    // Statuts occupants : fermes (défaut) ou fermes + en attente (flux public, anti-double-suggestion).
    const busyStatuses = opts?.excludeRequested ? [...BLOCKING, VehicleEventStatus.REQUESTED] : BLOCKING;

    const candidates = await this.prisma.vehicle.findMany({
      where,
      select: {
        id: true,
        plate: true,
        seats: true,
        childSeats: true,
        features: true,
        // Dormance : lue par JOINTURE sur la relation 1-1 déjà là (aucune requête de plus — le VPS
        // 2 vCPU ne pardonne pas un N+1 sur un parc de 2000). `lastSeenAt` est l'UNIQUE source :
        // ni Trip ni Position (vidés en mode vie privée alors que le boîtier parle), ni
        // `Tracker.status` (colonne collante, jamais remise à OFFLINE).
        tracker: { select: { id: true, lastSeenAt: true } },
      },
      take: 2000,
    });

    // Capacité filtrée EN JS (pas via `gte` Prisma, qui écarterait silencieusement les
    // NULL) : les véhicules à capacité inconnue sont COMPTÉS et rendus visibles à l'UI.
    let excludedUnknownCapacity = 0;
    const capacityOk = candidates.filter((v) => {
      if ((c.minSeats && v.seats == null) || (c.minChildSeats && v.childSeats == null)) {
        excludedUnknownCapacity++;
        return false;
      }
      if (c.minSeats && (v.seats ?? 0) < c.minSeats) return false;
      if (c.minChildSeats && (v.childSeats ?? 0) < c.minChildSeats) return false;
      return true;
    });

    // Équipements : superset insensible à la casse (non exprimable en `hasEvery` Prisma).
    const required = (c.requiredFeatures ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean);
    const matching =
      required.length === 0
        ? capacityOk
        : capacityOk.filter((v) => {
            const have = new Set(v.features.map((f) => f.toLowerCase()));
            return required.every((r) => have.has(r));
          });
    const empty = (excludedImmobilized: number, excludedDormant = 0): SuggestReservationResultDto => ({
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      vehicles: [],
      excludedUnknownCapacity,
      excludedImmobilized,
      excludedDormant,
    });
    if (matching.length === 0) return empty(0);

    // DORMANCE (seuil « arrêter de COMPTER » = 7 j) — proposer un véhicule dont le boîtier s'est tu
    // depuis plus d'une semaine, c'est promettre une voiture qu'on ne sait plus ni localiser ni
    // garantir présente : en prod FV-941-LZ (89 j de silence) et FL-787-KV (52 j) ressortaient
    // encore dans le vivier, y compris via l'attribution automatique d'une demande « ouverte » et
    // via le lien public de réservation. On les écarte ici, en AMONT — donc pour les 4 surfaces
    // d'un coup (disponibilité flotte, suggestion, lien public, attribution automatique).
    //
    // Écarté du PRÉSENT seulement : la fiche, l'historique et les réservations déjà posées ne
    // bougent pas, et le véhicule réintègre le vivier tout seul à la première trame reçue (dérivé
    // au read-time, aucun champ en base, aucun bouton « réactiver »).
    //
    // ⚠️ Un véhicule SANS boîtier (TEST-001-XX) n'est PAS dormant et reste réservable :
    // beaucoup de flottes exploitent parfaitement des véhicules non équipés. `isVehicleDormant`
    // renvoie déjà false sans trackerId ET quand le boîtier n'a JAMAIS émis — on ne contourne pas.
    //
    // Compté sur les véhicules CONFORMES aux critères (comme `excludedImmobilized`) : le chiffre
    // affiché répond à « combien j'aurais pu vous proposer si les boîtiers parlaient », pas
    // « combien de muets dans le parc ». Le filtre est appliqué AVANT les requêtes d'occupation :
    // inutile d'aller chercher les conflits d'un véhicule déjà hors vivier.
    const nowMs = Date.now();
    const awake = matching.filter(
      (v) =>
        !isVehicleDormant(
          { trackerId: v.tracker?.id ?? null, lastSeenAt: v.tracker?.lastSeenAt ?? null },
          nowMs,
          // 7 j, explicitement. Le seuil « AGIR » (72 h) ne s'applique PAS ici : proposer un
          // véhicule n'est pas lui envoyer une commande, et retirer à tort un vrai véhicule du
          // parc proposé au client coûte bien plus cher qu'une tentative de commande perdue.
          DORMANT_STOP_COUNTING_MS,
        ),
    );
    const excludedDormant = matching.length - awake.length;
    if (awake.length === 0) return empty(0, excludedDormant);

    const ids = awake.map((v) => v.id);
    const [busyResas, busyTrips, immobilized] = await Promise.all([
      this.prisma.vehicleEvent.findMany({
        where: {
          vehicleId: { in: ids },
          type: VehicleEventType.RESERVATION,
          status: { in: busyStatuses },
          startAt: { lt: end },
          endAt: { gt: start },
        },
        select: { vehicleId: true },
      }),
      this.prisma.trip.findMany({
        where: {
          vehicleId: { in: ids },
          startedAt: { lt: end },
          OR: [{ endedAt: { gt: start } }, ...this.openTripOr(start)],
        },
        select: { vehicleId: true },
      }),
      this.findImmobilized(ids, start, end),
    ]);
    const busy = new Set<string>([...busyResas.map((b) => b.vehicleId), ...busyTrips.map((b) => b.vehicleId)]);
    const excludedImmobilized = awake.filter((v) => immobilized.has(v.id)).length;
    const free = awake.filter((v) => !busy.has(v.id) && !immobilized.has(v.id));
    if (free.length === 0) return empty(excludedImmobilized, excludedDormant);

    const util = await this.recentUtilization(free.map((v) => v.id));
    const vehicles: SuggestedVehicleDto[] = free
      .map((v) => {
        const ratio = util.get(v.id) ?? 0;
        return {
          vehicleId: v.id,
          vehiclePlate: v.plate,
          seats: v.seats,
          childSeats: v.childSeats,
          features: v.features,
          utilizationRatio: Math.round(ratio * 100) / 100,
          underutilized: ratio < UNDERUTILIZED_RATIO,
        };
      })
      .sort((a, b) => a.utilizationRatio - b.utilizationRatio); // sous-utilisés d'abord

    return {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      vehicles,
      excludedUnknownCapacity,
      excludedImmobilized,
      excludedDormant,
    };
  }

  private async recentUtilization(vehicleIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (vehicleIds.length === 0) return out;
    const from = new Date(Date.now() - RECENT_WINDOW_MS);
    const trips = await this.prisma.trip.findMany({
      where: { vehicleId: { in: vehicleIds }, startedAt: { gte: from } },
      select: { vehicleId: true, durationSeconds: true },
    });
    const sum = new Map<string, number>();
    for (const t of trips) {
      sum.set(t.vehicleId, (sum.get(t.vehicleId) ?? 0) + (t.durationSeconds ?? 0) * 1000);
    }
    for (const id of vehicleIds) out.set(id, Math.min(1, (sum.get(id) ?? 0) / RECENT_WINDOW_MS));
    return out;
  }

  // ─── Demande → validation ──────────────────────────────────────────────────

  /** Demande de réservation (status REQUESTED, NON bloquant). Perm reservations_request. */
  async request(user: AuthUser, dto: RequestReservationDto): Promise<VehicleEventDto> {
    const { start, end } = this.parseSlot(dto.startAt, dto.endAt);

    // On ne réserve pas dans le passé. Seule EXCEPTION : consigner une réservation DÉJÀ EFFECTUÉE
    // mais non enregistrée (option « déjà effectuée ») — elle est alors placée à sa date réelle.
    const isPast = start.getTime() < Date.now();
    if (isPast && !dto.retroactive) {
      throw new BadRequestException(
        'Impossible de réserver une date passée. Pour consigner une réservation déjà effectuée mais non enregistrée, activez l’option « réservation déjà effectuée ».',
      );
    }
    if (dto.retroactive && !dto.vehicleId) {
      throw new BadRequestException('Précisez le véhicule concerné pour consigner une réservation déjà effectuée.');
    }
    // Rétroactif EFFECTIF = flag + créneau réellement passé (sur un créneau futur, le flag est ignoré
    // → réservation normale, tous les contrôles s'appliquent).
    const retro = !!dto.retroactive && isPast;

    let vehicleId = dto.vehicleId;
    let fleetId: string;
    if (vehicleId) {
      fleetId = await this.events.assertVehicleAccess(user, vehicleId); // 403/404
    } else {
      // Demande « ouverte » sur critères : on attache le meilleur véhicule libre (sous-utilisé d'abord).
      const sug = await this.suggest(user, {
        startAt: dto.startAt,
        endAt: dto.endAt,
        criteria: dto.criteria,
        fleetId: dto.fleetId,
      });
      if (sug.vehicles.length === 0) {
        // Seule surface HUMAINE où le compteur d'exclusion disparaîtrait : ici on ne renvoie pas le
        // DTO, on lève. Sans la mention, l'exploitant lit « aucun véhicule » comme « agenda plein »
        // et part chercher un conflit de créneau qui n'existe pas, alors que le vrai sujet est un
        // boîtier muet (batterie débranchée, SIM coupée) à faire réparer. Une exclusion ne fait
        // jamais baisser un chiffre client en silence — y compris dans un message d'erreur.
        // Chemin AUTHENTIFIÉ (le lien public passe par systemRequest) : aucune fuite d'état de parc.
        throw new BadRequestException(
          sug.excludedDormant > 0
            ? `Aucun véhicule libre ne correspond aux critères sur ce créneau (${sug.excludedDormant} véhicule(s) écarté(s) : boîtier muet depuis plus de 7 jours).`
            : 'Aucun véhicule libre ne correspond aux critères sur ce créneau.',
        );
      }
      vehicleId = sug.vehicles[0].vehicleId;
      fleetId = await this.events.assertVehicleAccess(user, vehicleId);
    }

    // Une réservation FERME existante (une autre réservation) sur le créneau rend la demande caduque —
    // y compris en rétroactif (on ne consigne pas deux fois le même créneau).
    const conflicts = await this.findOverlaps(vehicleId, start, end);
    if (conflicts.length > 0) {
      throw new ConflictException('Ce véhicule est déjà réservé sur ce créneau.');
    }
    // Rétroactif : le trajet réel (et une immobilisation passée) sont ATTENDUS — ils prouvent que la
    // réservation a eu lieu ; on ne bloque donc pas dessus. Pour une réservation à venir, on refuse.
    if (!retro) {
      if (await this.hasTripOverlap(vehicleId, start, end)) {
        throw new ConflictException('Ce véhicule roule déjà sur ce créneau.');
      }
      if ((await this.findImmobilized([vehicleId], start, end)).has(vehicleId)) {
        throw new ConflictException('Ce véhicule est immobilisé (incident ou maintenance) sur ce créneau.');
      }
    }

    // #5 — Placement DIRECT si l'appelant peut GÉRER les réservations de CE véhicule
    // (droit reservations_manage résolu par véhicule) : sa réservation entre CONFIRMÉE
    // dans l'agenda, sans passer par la file de demandes. Sinon (droit reservations_request
    // seul) → REQUESTED (une demande qu'un gestionnaire validera).
    const canManage = await this.permissions.canOnVehicle(user, vehicleId, 'reservations_manage');
    // Consigner une réservation passée est un acte de GESTION (jamais une demande à valider).
    if (retro && !canManage) {
      throw new ForbiddenException('Seul un gestionnaire peut consigner une réservation déjà effectuée.');
    }
    const status = canManage ? VehicleEventStatus.CONFIRMED : VehicleEventStatus.REQUESTED;

    try {
      const row = await this.prisma.vehicleEvent.create({
        data: {
          fleetId,
          vehicleId,
          type: VehicleEventType.RESERVATION,
          status,
          title: dto.title?.trim() || 'Réservation',
          startAt: start,
          endAt: end,
          allDay: false,
          metadata: {
            requesterId: user.id,
            reason: dto.reason ?? null,
            criteria: dto.criteria ?? null,
            ...(retro ? { retroactive: true } : {}),
          } as Prisma.InputJsonValue,
          createdBy: user.id,
          source: 'MANUAL',
        },
        include: INCLUDE_PLATE,
      });
      // Déclencheur agent : une réservation HUMAINE À VENIR vient d'être créée (l'agent décide selon
      // son toggle). Une consignation rétroactive (créneau passé) n'a rien à optimiser → pas de trigger.
      if (!retro) this.emitter?.emit('agenda-agent.trigger', { fleetId, kind: 'reservation' });
      return this.toDto(row);
    } catch (err) {
      // Une réservation FERME (CONFIRMED) est soumise à la contrainte EXCLUDE : traduire
      // la course concurrente en 409 lisible (le pré-check plus haut a déjà écarté le reste).
      if (status === VehicleEventStatus.CONFIRMED && this.isExclusionConflict(err)) {
        throw new ConflictException("Ce créneau vient d'être réservé (course concurrente).");
      }
      throw err;
    }
  }

  /** Validation d'une demande -> CONFIRMED (bloquant). Perm reservations_manage. */
  async confirm(user: AuthUser, id: string, dto: ConfirmReservationDto): Promise<VehicleEventDto> {
    const resa = await this.loadScoped(user, id);
    // Seule une demande EN ATTENTE peut être validée : pas de re-confirm d'un CONFIRMED/IN_PROGRESS
    // (qui régresserait le cycle de vie), ni d'un DONE/CANCELLED clôturé.
    if (resa.status !== VehicleEventStatus.REQUESTED) {
      throw new BadRequestException('Seule une demande en attente peut être validée.');
    }

    let vehicleId = resa.vehicleId;
    let fleetId = resa.fleetId;
    if (dto.vehicleId && dto.vehicleId !== vehicleId) {
      fleetId = await this.events.assertVehicleAccess(user, dto.vehicleId); // réaffectation
      vehicleId = dto.vehicleId;
    }

    if (!resa.endAt) throw new BadRequestException('Réservation sans créneau de fin.');
    // Pré-check (409 lisible) ; la contrainte EXCLUDE tranche la course concurrente.
    const conflicts = await this.findOverlaps(vehicleId, resa.startAt, resa.endAt, id);
    if (conflicts.length > 0) {
      throw new ConflictException('Conflit : une réservation ferme existe déjà sur ce créneau.');
    }
    // Cohérence avec la réalité : refuser si le véhicule roule déjà sur le créneau (symétrique
    // de request() ; surtout pertinent quand confirm réaffecte un autre véhicule).
    if (await this.hasTripOverlap(vehicleId, resa.startAt, resa.endAt)) {
      throw new ConflictException('Ce véhicule roule déjà sur ce créneau.');
    }
    if ((await this.findImmobilized([vehicleId], resa.startAt, resa.endAt)).has(vehicleId)) {
      throw new ConflictException('Ce véhicule est immobilisé (incident ou maintenance) sur ce créneau.');
    }

    try {
      const row = await this.prisma.vehicleEvent.update({
        where: { id },
        data: { status: VehicleEventStatus.CONFIRMED, vehicleId, fleetId },
        include: INCLUDE_PLATE,
      });
      // Réservation validée : notifier le demandeur (flux public P4). Le notifier ne réagit qu'aux
      // réservations `metadata.public` avec un contact ; sans effet pour les réservations internes.
      this.emitter?.emit('reservation.confirmed', {
        fleetId: row.fleetId,
        vehiclePlate: row.vehicle?.plate ?? null,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt ? row.endAt.toISOString() : null,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      });
      return this.toDto(row);
    } catch (err) {
      if (this.isExclusionConflict(err)) {
        throw new ConflictException('Conflit : ce créneau vient d\'être réservé (course concurrente).');
      }
      throw err;
    }
  }

  /** Refus / annulation -> CANCELLED. Perm reservations_manage. */
  async cancel(user: AuthUser, id: string): Promise<VehicleEventDto> {
    const resa = await this.loadScoped(user, id);
    // Un DONE est terminal (immuable) ; un CANCELLED est idempotent.
    if (resa.status === VehicleEventStatus.DONE) {
      throw new BadRequestException('Une réservation terminée ne peut pas être annulée.');
    }
    if (resa.status === VehicleEventStatus.CANCELLED) return this.toDto(resa);
    const row = await this.prisma.vehicleEvent.update({
      where: { id },
      data: { status: VehicleEventStatus.CANCELLED, resolvedAt: new Date() },
      include: INCLUDE_PLATE,
    });
    return this.toDto(row);
  }

  /**
   * Édition d'une réservation (créneau / critères / libellé / VÉHICULE). Perm reservations_manage.
   * Une réservation VALIDÉE (CONFIRMED) reste éditable : le créneau, le motif, les critères ET le
   * véhicule affecté peuvent changer, avec re-vérification des conflits sur la cible (véhicule +
   * créneau) et la contrainte EXCLUDE en dernier rempart.
   */
  async update(user: AuthUser, id: string, dto: UpdateReservationDto): Promise<VehicleEventDto> {
    const resa = await this.loadScoped(user, id);

    let start = resa.startAt;
    let end = resa.endAt;
    const data: Prisma.VehicleEventUncheckedUpdateInput = {};
    const slotChanged = dto.startAt !== undefined || dto.endAt !== undefined;
    if (slotChanged) {
      const slot = this.parseSlot(dto.startAt ?? resa.startAt.toISOString(), dto.endAt ?? resa.endAt?.toISOString() ?? '');
      start = slot.start;
      end = slot.end;
      data.startAt = start;
      data.endAt = end;
    }
    // Une réservation « déjà effectuée » (metadata.retroactive, ou marquée telle par le client) reste
    // éditable même sur un créneau passé. Sinon, on interdit de DÉPLACER une réservation dans le passé.
    const isRetro =
      (resa.metadata as { retroactive?: unknown } | null)?.retroactive === true || dto.retroactive === true;
    if (slotChanged && start.getTime() < Date.now() && !isRetro) {
      throw new BadRequestException(
        'Impossible de déplacer une réservation dans le passé. Pour une réservation déjà effectuée, activez l’option « réservation déjà effectuée ».',
      );
    }
    if (dto.title !== undefined) data.title = dto.title.trim() || 'Réservation';
    if (dto.reason !== undefined || dto.criteria !== undefined) {
      const meta = (resa.metadata as Record<string, unknown> | null) ?? {};
      data.metadata = {
        ...meta,
        ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
        ...(dto.criteria !== undefined ? { criteria: dto.criteria } : {}),
      } as Prisma.InputJsonValue;
    }

    // Réaffectation de véhicule (ex. changer le véhicule d'une réservation validée). Le fleetId
    // est DÉRIVÉ du nouveau véhicule via assertVehicleAccess (anti-IDOR, jamais lu du client).
    let targetVehicleId = resa.vehicleId;
    const vehicleChanged = !!dto.vehicleId && dto.vehicleId !== resa.vehicleId;
    if (vehicleChanged) {
      const newFleetId = await this.events.assertVehicleAccess(user, dto.vehicleId!); // 403/404
      targetVehicleId = dto.vehicleId!;
      data.vehicleId = targetVehicleId;
      data.fleetId = newFleetId;
    }

    // Réservation bloquante + (créneau OU véhicule change) → re-vérifier les conflits sur la CIBLE.
    const blocking = resa.status === VehicleEventStatus.CONFIRMED || resa.status === VehicleEventStatus.IN_PROGRESS;
    if (blocking && (slotChanged || vehicleChanged) && end) {
      const conflicts = await this.findOverlaps(targetVehicleId, start, end, id);
      if (conflicts.length > 0) throw new ConflictException('Conflit sur le nouveau créneau.');
      // Rétroactif : le trajet réel / l'immobilisation passée sont attendus → on ne bloque pas dessus.
      if (!isRetro) {
        if (await this.hasTripOverlap(targetVehicleId, start, end)) {
          throw new ConflictException('Ce véhicule roule déjà sur le nouveau créneau.');
        }
        if ((await this.findImmobilized([targetVehicleId], start, end)).has(targetVehicleId)) {
          throw new ConflictException('Ce véhicule est immobilisé (incident ou maintenance) sur le nouveau créneau.');
        }
      }
    }

    try {
      const row = await this.prisma.vehicleEvent.update({ where: { id }, data, include: INCLUDE_PLATE });
      return this.toDto(row);
    } catch (err) {
      if (this.isExclusionConflict(err)) {
        throw new ConflictException('Conflit : créneau déjà réservé.');
      }
      throw err;
    }
  }

  /** Liste des réservations (scopée). Délègue au scoping/mapping S7. Perm reservations_view. */
  async list(
    user: AuthUser,
    filters: { from: Date; to: Date; status?: VehicleEventStatus; vehicleId?: string; groupId?: string },
  ): Promise<VehicleEventDto[]> {
    return this.events.list(user, {
      from: filters.from,
      to: filters.to,
      type: VehicleEventType.RESERVATION,
      status: filters.status,
      vehicleId: filters.vehicleId,
      groupId: filters.groupId,
    });
  }

  // ─── Agent d'agenda (P3) : disponibilité + création système ────────────────

  /**
   * Le véhicule est-il ENGAGEABLE sur [start,end) ? (résa ferme + trajet réel + immobilisation
   * + boîtier qui parle encore).
   *
   * ⚠️ Ce prédicat n'a que des appelants d'ENGAGEMENT — `systemConfirm` juste en dessous et
   * l'agent d'agenda nocturne. Il ne sert nulle part à afficher une disponibilité. C'est pourquoi
   * la dormance a sa place ICI et pas seulement dans le vivier de suggestion : l'agent nocturne
   * NE PASSE PAS par le vivier (il applique un motif récurrent puis appelle directement ce
   * prédicat), donc sans cette 4ᵉ condition il pouvait poser une réservation FERME sur un véhicule
   * muet depuis 89 jours — la seule voie par laquelle un dormant continuait d'être engagé.
   *
   * Placé en DERNIER à dessein : les trois conflits ci-dessus disqualifient la plupart des
   * candidats sans requête supplémentaire ; on ne paie la lecture du boîtier que lorsqu'on est
   * réellement sur le point d'engager le véhicule (VPS à 2 vCPU).
   */
  async isVehicleFree(vehicleId: string, start: Date, end: Date): Promise<boolean> {
    if ((await this.findOverlaps(vehicleId, start, end)).length > 0) return false;
    if (await this.hasTripOverlap(vehicleId, start, end)) return false;
    if ((await this.findImmobilized([vehicleId], start, end)).has(vehicleId)) return false;
    // Seuil « arrêter de COMPTER » (7 j) : engager un véhicule n'est pas lui envoyer une commande.
    // Un véhicule SANS boîtier reste engageable — `isVehicleDormant` renvoie déjà false sans
    // trackerId, et beaucoup de flottes exploitent des véhicules non équipés.
    const veh = await this.prisma.vehicle
      .findUnique({ where: { id: vehicleId }, select: { tracker: { select: { id: true, lastSeenAt: true } } } })
      .catch(() => null);
    if (
      isVehicleDormant(
        { trackerId: veh?.tracker?.id ?? null, lastSeenAt: veh?.tracker?.lastSeenAt ?? null },
        Date.now(),
        DORMANT_STOP_COUNTING_MS,
      )
    ) {
      return false;
    }
    return true;
  }

  /**
   * Création SYSTÈME d'une réservation FERME (agent nocturne / application d'une proposition).
   * Rejoue les pré-checks + s'appuie sur la contrainte EXCLUDE ; renvoie null si le créneau est
   * occupé (course incluse), ne lève que sur erreur inattendue. La permission est vérifiée EN AMONT
   * (agent scopé flotte, ou application humaine déjà gardée par reservations_manage).
   */
  async systemConfirm(input: {
    fleetId: string;
    vehicleId: string;
    start: Date;
    end: Date;
    title: string;
    createdBy?: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<VehicleEventDto | null> {
    const { fleetId, vehicleId, start, end } = input;
    if (!(await this.isVehicleFree(vehicleId, start, end))) return null;
    try {
      const row = await this.prisma.vehicleEvent.create({
        data: {
          fleetId,
          vehicleId,
          type: VehicleEventType.RESERVATION,
          status: VehicleEventStatus.CONFIRMED,
          title: input.title,
          startAt: start,
          endAt: end,
          allDay: false,
          metadata: input.metadata ?? Prisma.JsonNull,
          createdBy: input.createdBy ?? SYSTEM_ACTOR_ID,
          source: 'SYSTEM',
        },
        include: INCLUDE_PLATE,
      });
      return this.toDto(row);
    } catch (err) {
      if (this.isExclusionConflict(err)) return null; // course : créneau pris entre-temps
      throw err;
    }
  }

  /**
   * Création SYSTÈME d'une DEMANDE (REQUESTED, non bloquante) — flux public P4. La demande atterrit
   * dans la file de validation ; un gestionnaire la confirme (aucune permission publique). Le véhicule
   * a déjà été vérifié appartenir à la flotte du lien EN AMONT (booking service).
   */
  async systemRequest(input: {
    fleetId: string;
    vehicleId: string;
    start: Date;
    end: Date;
    title: string;
    metadata?: Prisma.InputJsonValue;
  }): Promise<VehicleEventDto> {
    const row = await this.prisma.vehicleEvent.create({
      data: {
        fleetId: input.fleetId,
        vehicleId: input.vehicleId,
        type: VehicleEventType.RESERVATION,
        status: VehicleEventStatus.REQUESTED,
        title: input.title,
        startAt: input.start,
        endAt: input.end,
        allDay: false,
        metadata: input.metadata ?? Prisma.JsonNull,
        createdBy: SYSTEM_ACTOR_ID,
        source: 'SYSTEM',
      },
      include: INCLUDE_PLATE,
    });
    return this.toDto(row);
  }
}
