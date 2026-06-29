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
import type { AuthUser } from '../auth/types/auth-user';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { VehicleEventsService } from './vehicle-events.service';

type EventRow = Prisma.VehicleEventGetPayload<{ include: { vehicle: { select: { plate: true } } } }>;
const INCLUDE_PLATE = { vehicle: { select: { plate: true } } } as const;

/** Statuts « bloquants » : occupent le véhicule (conflits + disponibilité). */
const BLOCKING: VehicleEventStatus[] = [VehicleEventStatus.CONFIRMED, VehicleEventStatus.IN_PROGRESS];
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

  private async resolveScope(user: AuthUser): Promise<{ fleetId?: string; ids: string[] | 'ALL' }> {
    let fleetId: string | undefined;
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associee');
      fleetId = user.fleetId;
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

  /** Un trajet RÉEL chevauche-t-il le créneau (véhicule effectivement pris) ? */
  private async hasTripOverlap(vehicleId: string, start: Date, end: Date): Promise<boolean> {
    const t = await this.prisma.trip.findFirst({
      where: { vehicleId, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
      select: { id: true },
    });
    return !!t;
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
    query: { startAt: string; endAt: string; criteria?: RequestReservationDto['criteria'] },
  ): Promise<SuggestReservationResultDto> {
    const { start, end } = this.parseSlot(query.startAt, query.endAt);
    const scope = await this.resolveScope(user);

    const where: Prisma.VehicleWhereInput = {};
    if (scope.fleetId) where.fleetId = scope.fleetId;
    if (scope.ids !== 'ALL') where.id = { in: scope.ids };
    const c = this.sanitizeCriteria(query.criteria);
    if (c.minSeats) where.seats = { gte: c.minSeats };
    if (c.minChildSeats) where.childSeats = { gte: c.minChildSeats };

    const candidates = await this.prisma.vehicle.findMany({
      where,
      select: { id: true, plate: true, seats: true, childSeats: true, features: true },
      take: 2000,
    });

    // Équipements : superset insensible à la casse (non exprimable en `hasEvery` Prisma).
    const required = (c.requiredFeatures ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean);
    const matching =
      required.length === 0
        ? candidates
        : candidates.filter((v) => {
            const have = new Set(v.features.map((f) => f.toLowerCase()));
            return required.every((r) => have.has(r));
          });
    if (matching.length === 0) {
      return { startAt: start.toISOString(), endAt: end.toISOString(), vehicles: [] };
    }

    const ids = matching.map((v) => v.id);
    const [busyResas, busyTrips] = await Promise.all([
      this.prisma.vehicleEvent.findMany({
        where: {
          vehicleId: { in: ids },
          type: VehicleEventType.RESERVATION,
          status: { in: BLOCKING },
          startAt: { lt: end },
          endAt: { gt: start },
        },
        select: { vehicleId: true },
      }),
      this.prisma.trip.findMany({
        where: { vehicleId: { in: ids }, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] },
        select: { vehicleId: true },
      }),
    ]);
    const busy = new Set<string>([...busyResas.map((b) => b.vehicleId), ...busyTrips.map((b) => b.vehicleId)]);
    const free = matching.filter((v) => !busy.has(v.id));
    if (free.length === 0) {
      return { startAt: start.toISOString(), endAt: end.toISOString(), vehicles: [] };
    }

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

    return { startAt: start.toISOString(), endAt: end.toISOString(), vehicles };
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

    let vehicleId = dto.vehicleId;
    let fleetId: string;
    if (vehicleId) {
      fleetId = await this.events.assertVehicleAccess(user, vehicleId); // 403/404
    } else {
      // Demande « ouverte » sur critères : on attache le meilleur véhicule libre (sous-utilisé d'abord).
      const sug = await this.suggest(user, { startAt: dto.startAt, endAt: dto.endAt, criteria: dto.criteria });
      if (sug.vehicles.length === 0) {
        throw new BadRequestException('Aucun véhicule libre ne correspond aux critères sur ce créneau.');
      }
      vehicleId = sug.vehicles[0].vehicleId;
      fleetId = await this.events.assertVehicleAccess(user, vehicleId);
    }

    // Une réservation FERME existante (ou un trajet réel) sur le créneau rend la demande caduque.
    const conflicts = await this.findOverlaps(vehicleId, start, end);
    if (conflicts.length > 0) {
      throw new ConflictException('Ce véhicule est déjà réservé sur ce créneau.');
    }
    if (await this.hasTripOverlap(vehicleId, start, end)) {
      throw new ConflictException('Ce véhicule roule déjà sur ce créneau.');
    }

    const row = await this.prisma.vehicleEvent.create({
      data: {
        fleetId,
        vehicleId,
        type: VehicleEventType.RESERVATION,
        status: VehicleEventStatus.REQUESTED,
        title: dto.title?.trim() || 'Réservation',
        startAt: start,
        endAt: end,
        allDay: false,
        metadata: {
          requesterId: user.id,
          reason: dto.reason ?? null,
          criteria: dto.criteria ?? null,
        } as Prisma.InputJsonValue,
        createdBy: user.id,
        source: 'MANUAL',
      },
      include: INCLUDE_PLATE,
    });
    return this.toDto(row);
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

    try {
      const row = await this.prisma.vehicleEvent.update({
        where: { id },
        data: { status: VehicleEventStatus.CONFIRMED, vehicleId, fleetId },
        include: INCLUDE_PLATE,
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

  /** Édition (créneau / critères / libellé). Perm reservations_manage. */
  async update(user: AuthUser, id: string, dto: UpdateReservationDto): Promise<VehicleEventDto> {
    const resa = await this.loadScoped(user, id);

    let start = resa.startAt;
    let end = resa.endAt;
    const data: Prisma.VehicleEventUpdateInput = {};
    if (dto.startAt !== undefined || dto.endAt !== undefined) {
      const slot = this.parseSlot(dto.startAt ?? resa.startAt.toISOString(), dto.endAt ?? resa.endAt?.toISOString() ?? '');
      start = slot.start;
      end = slot.end;
      data.startAt = start;
      data.endAt = end;
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

    // Si la réservation est bloquante et le créneau change, re-vérifier les conflits.
    const blocking = resa.status === VehicleEventStatus.CONFIRMED || resa.status === VehicleEventStatus.IN_PROGRESS;
    if (blocking && (dto.startAt !== undefined || dto.endAt !== undefined) && end) {
      const conflicts = await this.findOverlaps(resa.vehicleId, start, end, id);
      if (conflicts.length > 0) throw new ConflictException('Conflit sur le nouveau créneau.');
      if (await this.hasTripOverlap(resa.vehicleId, start, end)) {
        throw new ConflictException('Ce véhicule roule déjà sur le nouveau créneau.');
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
}
