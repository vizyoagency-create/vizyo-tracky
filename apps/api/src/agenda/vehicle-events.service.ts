import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type {
  AgendaSummaryDto,
  CreateVehicleEventDto,
  OdometerEstimateDto,
  ReportIncidentDto,
  UpdateVehicleEventDto,
  VehicleEventDto,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

const DAY_MS = 24 * 60 * 60 * 1000;

type EventRow = Prisma.VehicleEventGetPayload<{ include: { vehicle: { select: { plate: true } } } }>;

/**
 * Sprint 7 — CRUD des événements d'agenda (générique : maintenance + incidents). Scoping
 * tenant STRICT (anti-IDOR) réutilisant la chaîne S5 : `getAccessibleVehicleIds` +
 * `resolveReportVehicleScope`. Aucune donnée hors périmètre véhicule de l'utilisateur.
 */
@Injectable()
export class VehicleEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    // EventEmitter2 est global (EventEmitterModule.forRoot) : injecté en prod, omis dans les specs.
    private readonly emitter?: EventEmitter2,
  ) {}

  /** Notifie l'agent d'agenda qu'un incident/maintenance vient d'être créé (déclencheur P3). */
  private emitAgentTrigger(fleetId: string, kind: 'incident' | 'maintenance'): void {
    this.emitter?.emit('agenda-agent.trigger', { fleetId, kind });
  }

  /** Vérifie l'accès à un véhicule (cross-flotte + IDOR intra-flotte) → renvoie son fleetId. */
  async assertVehicleAccess(user: AuthUser, vehicleId: string): Promise<string> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, fleetId: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicule introuvable');
    if (user.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== user.fleetId) {
      throw new ForbiddenException('Vehicule hors de votre flotte');
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    resolveReportVehicleScope(accessible, [vehicleId]); // 403 si hors perimetre per-vehicule
    return vehicle.fleetId;
  }

  /** WHERE scopé (flotte + périmètre véhicules) pour les listes/compteurs. */
  private async scopedWhere(
    user: AuthUser,
    requestedVehicleIds?: string[],
    fleetId?: string,
  ): Promise<Prisma.VehicleEventWhereInput> {
    const where: Prisma.VehicleEventWhereInput = {};
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associee');
      where.fleetId = user.fleetId;
    } else if (fleetId) {
      // Filtre société global (SUPER_ADMIN) : restreint à la société choisie dans le top-bar.
      where.fleetId = fleetId;
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const scope = resolveReportVehicleScope(accessible, requestedVehicleIds);
    if (scope !== 'ALL') where.vehicleId = { in: scope };
    return where;
  }

  /** vehicleIds d'un groupe (le groupe doit appartenir à la flotte de l'user, sauf super-admin). */
  private async groupVehicleIds(user: AuthUser, groupId: string): Promise<string[]> {
    const assignments = await this.prisma.vehicleGroupAssignment.findMany({
      where: {
        groupId,
        ...(user.role !== UserRole.SUPER_ADMIN
          ? { group: { fleetId: user.fleetId ?? '__none__' } }
          : {}),
      },
      select: { vehicleId: true },
    });
    return assignments.map((a) => a.vehicleId);
  }

  async list(
    user: AuthUser,
    q: {
      from: Date;
      to: Date;
      vehicleId?: string;
      groupId?: string;
      type?: VehicleEventType;
      status?: VehicleEventStatus;
      fleetId?: string;
    },
  ): Promise<VehicleEventDto[]> {
    let requested: string[] | undefined;
    if (q.vehicleId) requested = [q.vehicleId];
    else if (q.groupId) {
      requested = await this.groupVehicleIds(user, q.groupId);
      if (requested.length === 0) return []; // groupe vide -> ne rien exposer d'autre
    }

    const where = await this.scopedWhere(user, requested, q.fleetId);
    // Fenêtre temporelle : événements qui chevauchent [from, to].
    where.AND = [
      {
        OR: [
          { endAt: null, startAt: { gte: q.from, lte: q.to } },
          { startAt: { lte: q.to }, endAt: { gte: q.from } },
        ],
      },
    ];
    if (q.type) where.type = q.type;
    if (q.status) where.status = q.status;

    const rows = await this.prisma.vehicleEvent.findMany({
      where,
      include: { vehicle: { select: { plate: true } } },
      orderBy: { startAt: 'asc' },
      take: 1000,
    });
    return rows.map((r) => this.toDto(r));
  }

  async summary(user: AuthUser, fleetId?: string): Promise<AgendaSummaryDto> {
    const where = await this.scopedWhere(user, undefined, fleetId);
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * DAY_MS);
    const [overdue, upcoming, openIncidents] = await Promise.all([
      this.prisma.vehicleEvent.count({
        where: {
          ...where,
          status: VehicleEventStatus.PLANNED,
          startAt: { lt: now },
        },
      }),
      this.prisma.vehicleEvent.count({
        where: { ...where, status: VehicleEventStatus.PLANNED, startAt: { gte: now, lte: in30 } },
      }),
      this.prisma.vehicleEvent.count({
        where: {
          ...where,
          type: VehicleEventType.INCIDENT,
          status: { in: [VehicleEventStatus.OPEN, VehicleEventStatus.IN_PROGRESS] },
        },
      }),
    ]);
    return { overdue, upcoming, openIncidents };
  }

  async create(user: AuthUser, dto: CreateVehicleEventDto): Promise<VehicleEventDto> {
    if (dto.type === VehicleEventType.RESERVATION) {
      throw new BadRequestException('Les reservations seront gerees au Sprint 8');
    }
    const fleetId = await this.assertVehicleAccess(user, dto.vehicleId);
    const startAt = this.parseDate(dto.startAt, 'startAt');
    const endAt = dto.endAt ? this.parseDate(dto.endAt, 'endAt') : null;
    const row = await this.prisma.vehicleEvent.create({
      data: {
        fleetId,
        vehicleId: dto.vehicleId,
        type: dto.type,
        category: dto.category ?? null,
        status: dto.status ?? VehicleEventStatus.PLANNED,
        severity: dto.severity ?? null,
        title: dto.title.trim(),
        description: dto.description ?? null,
        startAt,
        endAt,
        allDay: dto.allDay ?? true,
        // Un incident immobilise par défaut (roue crevée = indisponible) ; une maintenance non.
        blocksVehicle: dto.blocksVehicle ?? dto.type === VehicleEventType.INCIDENT,
        odometerKm: dto.odometerKm ?? null,
        metadata: dto.metadata ? (dto.metadata as Prisma.InputJsonValue) : undefined,
        createdBy: user.id,
        source: 'MANUAL',
      },
      include: { vehicle: { select: { plate: true } } },
    });
    await this.maybeUpdateOdometer(dto.vehicleId, dto.odometerKm, startAt);
    if (row.type === VehicleEventType.INCIDENT || row.type === VehicleEventType.MAINTENANCE) {
      this.emitAgentTrigger(row.fleetId, row.type === VehicleEventType.INCIDENT ? 'incident' : 'maintenance');
    }
    return this.toDto(row);
  }

  async reportIncident(user: AuthUser, dto: ReportIncidentDto): Promise<VehicleEventDto> {
    const fleetId = await this.assertVehicleAccess(user, dto.vehicleId);
    const row = await this.prisma.vehicleEvent.create({
      data: {
        fleetId,
        vehicleId: dto.vehicleId,
        type: VehicleEventType.INCIDENT,
        status: VehicleEventStatus.OPEN,
        severity: dto.severity ?? 'MEDIUM',
        title: dto.title.trim(),
        description: dto.description ?? null,
        startAt: new Date(),
        allDay: true,
        blocksVehicle: dto.blocksVehicle ?? true,
        createdBy: user.id,
        source: 'MANUAL',
      },
      include: { vehicle: { select: { plate: true } } },
    });
    this.emitAgentTrigger(row.fleetId, 'incident');
    return this.toDto(row);
  }

  async update(user: AuthUser, id: string, dto: UpdateVehicleEventDto): Promise<VehicleEventDto> {
    const existing = await this.loadScoped(user, id);
    // Sprint 8 — une réservation ne se gère QUE via ReservationsService (perms reservations_*),
    // jamais via l'endpoint agenda générique : sinon agenda_manage contournerait reservations_manage
    // et court-circuiterait les pré-checks de conflit. Symétrique du refus dans create().
    if (existing.type === VehicleEventType.RESERVATION) {
      throw new BadRequestException('Les réservations se gèrent depuis l\'espace Réservations.');
    }
    const data: Prisma.VehicleEventUpdateInput = {};
    if (dto.status !== undefined) {
      data.status = dto.status;
      if (dto.status === VehicleEventStatus.DONE) data.resolvedAt = new Date();
    }
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.severity !== undefined) data.severity = dto.severity;
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.startAt !== undefined) data.startAt = this.parseDate(dto.startAt, 'startAt');
    if (dto.endAt !== undefined) data.endAt = dto.endAt ? this.parseDate(dto.endAt, 'endAt') : null;
    if (dto.allDay !== undefined) data.allDay = dto.allDay;
    if (dto.blocksVehicle !== undefined) data.blocksVehicle = dto.blocksVehicle;
    if (dto.odometerKm !== undefined) data.odometerKm = dto.odometerKm;
    if (dto.linkedEventId !== undefined) {
      // Anti-IDOR : un lien ne peut pointer que vers un evenement DANS le perimetre (S8-ready).
      if (dto.linkedEventId) await this.loadScoped(user, dto.linkedEventId);
      data.linkedEventId = dto.linkedEventId;
    }
    if (dto.metadata !== undefined) data.metadata = dto.metadata as Prisma.InputJsonValue;

    const row = await this.prisma.vehicleEvent.update({
      where: { id },
      data,
      include: { vehicle: { select: { plate: true } } },
    });
    if (dto.odometerKm !== undefined) {
      await this.maybeUpdateOdometer(existing.vehicleId, dto.odometerKm, row.startAt);
    }
    return this.toDto(row);
  }

  async remove(user: AuthUser, id: string): Promise<{ ok: true }> {
    const existing = await this.loadScoped(user, id);
    if (existing.type === VehicleEventType.RESERVATION) {
      throw new BadRequestException('Les réservations se gèrent depuis l\'espace Réservations.');
    }
    await this.prisma.vehicleEvent.delete({ where: { id } });
    return { ok: true };
  }

  async estimateOdometer(user: AuthUser, vehicleId: string): Promise<OdometerEstimateDto> {
    await this.assertVehicleAccess(user, vehicleId);
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { lastOdometerKm: true, lastOdometerAt: true },
    });
    const since = vehicle?.lastOdometerAt ?? undefined;
    const agg = await this.prisma.trip.aggregate({
      where: { vehicleId, ...(since ? { startedAt: { gte: since } } : {}) },
      _sum: { distanceKm: true },
    });
    const gpsSince = Math.round(agg._sum.distanceKm ?? 0);
    const base = vehicle?.lastOdometerKm ?? null;
    const estimated = base !== null ? base + gpsSince : gpsSince > 0 ? gpsSince : null;
    return {
      vehicleId,
      lastOdometerKm: base,
      lastOdometerAt: vehicle?.lastOdometerAt?.toISOString() ?? null,
      gpsDistanceSinceKm: gpsSince,
      estimatedKm: estimated,
    };
  }

  /** Charge un événement en garantissant qu'il est dans le périmètre de l'user. */
  private async loadScoped(user: AuthUser, id: string): Promise<{ vehicleId: string; type: VehicleEventType }> {
    const where = await this.scopedWhere(user);
    const ev = await this.prisma.vehicleEvent.findFirst({
      where: { ...where, id },
      select: { id: true, vehicleId: true, type: true },
    });
    if (!ev) throw new NotFoundException('Evenement introuvable');
    return ev;
  }

  /** Met à jour le baseline km du véhicule (jamais en arrière : on n'écrase qu'avec une saisie plus récente). */
  async maybeUpdateOdometer(
    vehicleId: string,
    odometerKm: number | null | undefined,
    at: Date,
  ): Promise<void> {
    if (odometerKm == null) return;
    const v = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { lastOdometerAt: true },
    });
    if (v?.lastOdometerAt && v.lastOdometerAt.getTime() > at.getTime()) return;
    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { lastOdometerKm: odometerKm, lastOdometerAt: at },
    });
  }

  private parseDate(raw: string, field: string): Date {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`${field} doit etre une date ISO valide`);
    }
    return d;
  }

  toDto(r: EventRow): VehicleEventDto {
    return {
      id: r.id,
      fleetId: r.fleetId,
      vehicleId: r.vehicleId,
      vehiclePlate: r.vehicle?.plate ?? null,
      type: r.type,
      category: r.category,
      status: r.status,
      severity: (r.severity as VehicleEventDto['severity']) ?? null,
      title: r.title,
      description: r.description,
      startAt: r.startAt.toISOString(),
      endAt: r.endAt?.toISOString() ?? null,
      allDay: r.allDay,
      blocksVehicle: r.blocksVehicle,
      odometerKm: r.odometerKm,
      planId: r.planId,
      linkedEventId: r.linkedEventId,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
