import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommandStatus, EngineAction, Prisma, UserRole } from '@prisma/client';
import type { Vehicle } from '@prisma/client';
import type { VehicleSnapshotDto } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateVehicleDto } from './dto/create-vehicle.dto';
import type { UpdateVehicleDto } from './dto/update-vehicle.dto';

export interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
  accessibleVehicleIds?: string[] | 'ALL';
}

@Injectable()
export class VehiclesService {
  /**
   * Phase 2 — Select Prisma minimal pour inclure le conducteur courant dans
   * les responses Vehicle (cf. DriverSummaryDto cote shared).
   */
  static readonly CURRENT_DRIVER_INCLUDE = {
    currentDriver: {
      select: { id: true, firstName: true, lastName: true, color: true, isActive: true },
    },
  } as const;

  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateVehicleDto, requestedBy: RequestedBy): Promise<Vehicle> {
    let fleetId: string;

    if (requestedBy.role === UserRole.SUPER_ADMIN) {
      if (!dto.fleetId) {
        throw new BadRequestException(
          'En tant que SUPER_ADMIN, vous devez sélectionner une flotte',
        );
      }
      fleetId = dto.fleetId;
    } else if (requestedBy.fleetId) {
      if (dto.fleetId && dto.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException(
          'Impossible de créer un véhicule dans une autre flotte',
        );
      }
      fleetId = requestedBy.fleetId;
    } else {
      throw new ForbiddenException('Aucune flotte associée à votre compte');
    }

    try {
      return await this.prisma.vehicle.create({
        data: {
          fleetId,
          plate: dto.plate,
          type: dto.type,
          brand: dto.brand,
          model: dto.model,
          year: dto.year,
          color: dto.color,
        },
        include: { tracker: true, ...VehiclesService.CURRENT_DRIVER_INCLUDE },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Plaque "${dto.plate}" déjà utilisée dans cette flotte`);
      }
      throw err;
    }
  }

  async findAll(
    requestedBy: RequestedBy,
    filters?: { search?: string; hasTracker?: string; limit?: number; cursor?: string },
  ): Promise<Vehicle[]> {
    const limit = Math.min(filters?.limit ?? 50, 50);
    const where: Prisma.VehicleWhereInput = {};

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      where.fleetId = requestedBy.fleetId ?? undefined;
    }

    // Filtrage par accès véhicules (sous-utilisateurs)
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      where.id = { in: requestedBy.accessibleVehicleIds };
    }

    if (filters?.search) {
      where.OR = [
        { plate: { contains: filters.search, mode: 'insensitive' } },
        { brand: { contains: filters.search, mode: 'insensitive' } },
        { model: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    if (filters?.hasTracker === 'true') {
      where.tracker = { isNot: null };
    } else if (filters?.hasTracker === 'false') {
      where.tracker = { is: null };
    }

    return this.prisma.vehicle.findMany({
      where,
      include: { tracker: true, ...VehiclesService.CURRENT_DRIVER_INCLUDE },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(filters?.cursor ? { skip: 1, cursor: { id: filters.cursor } } : {}),
    });
  }

  async findOne(id: string, requestedBy: RequestedBy): Promise<Vehicle> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id },
      include: {
        tracker: true,
        schedule: { select: { enabled: true } },
        ...VehiclesService.CURRENT_DRIVER_INCLUDE,
      },
    });

    if (!vehicle) throw new NotFoundException('Véhicule introuvable');

    if (requestedBy.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Accès refusé à ce véhicule');
    }

    // Vérifier accès véhicule pour les sous-utilisateurs
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL' && !requestedBy.accessibleVehicleIds.includes(vehicle.id)) {
      throw new ForbiddenException('Accès refusé à ce véhicule');
    }

    return vehicle;
  }

  async update(id: string, dto: UpdateVehicleDto, requestedBy: RequestedBy): Promise<Vehicle> {
    const vehicle = await this.findOne(id, requestedBy);

    if (dto.fleetId && dto.fleetId !== vehicle.fleetId && requestedBy.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Impossible de changer la flotte du véhicule');
    }

    const data: Prisma.VehicleUpdateInput = {};
    if (dto.plate !== undefined) data.plate = dto.plate;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.brand !== undefined) data.brand = dto.brand;
    if (dto.model !== undefined) data.model = dto.model;
    if (dto.year !== undefined) data.year = dto.year;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.fleetId !== undefined && requestedBy.role === UserRole.SUPER_ADMIN) {
      data.fleet = { connect: { id: dto.fleetId } };
    }

    try {
      return await this.prisma.vehicle.update({
        where: { id },
        data,
        include: { tracker: true, ...VehiclesService.CURRENT_DRIVER_INCLUDE },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Plaque "${dto.plate}" déjà utilisée dans cette flotte`);
      }
      throw err;
    }
  }

  async remove(id: string, requestedBy: RequestedBy): Promise<void> {
    const vehicle = await this.findOne(id, requestedBy);

    if ((vehicle as any).tracker) {
      await this.prisma.tracker.update({
        where: { vehicleId: vehicle.id },
        data: { vehicleId: null },
      });
    }

    await this.prisma.vehicle.delete({ where: { id } });
  }

  async stats(requestedBy: RequestedBy): Promise<{
    total: number;
    moving: number;
    idle: number;
    criticalAlerts: number;
    newThisMonth: number;
  }> {
    let fleetFilter: Prisma.VehicleWhereInput =
      requestedBy.role === UserRole.SUPER_ADMIN ? {} : { fleetId: requestedBy.fleetId ?? undefined };

    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      fleetFilter = { ...fleetFilter, id: { in: requestedBy.accessibleVehicleIds } };
    }

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [total, newThisMonth, movingVehicles, criticalAlerts] = await Promise.all([
      this.prisma.vehicle.count({ where: fleetFilter }),
      this.prisma.vehicle.count({ where: { ...fleetFilter, createdAt: { gte: monthStart } } }),
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT v."id") as count
        FROM vehicles v
        JOIN trackers t ON t."vehicleId" = v."id"
        JOIN positions p ON p."trackerId" = t."id"
        WHERE p."timestamp" > ${fiveMinAgo}
          AND p."speedKmh" > 5
          ${requestedBy.role !== UserRole.SUPER_ADMIN && requestedBy.fleetId
            ? Prisma.sql`AND v."fleetId" = ${requestedBy.fleetId}::uuid`
            : Prisma.empty}
          ${requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL'
            ? Prisma.sql`AND v."id" = ANY(${requestedBy.accessibleVehicleIds}::uuid[])`
            : Prisma.empty}
      `,
      this.prisma.alert.count({
        where: {
          severity: 'CRITICAL',
          acknowledgedAt: null,
          ...(requestedBy.role !== UserRole.SUPER_ADMIN && requestedBy.fleetId
            ? { fleetId: requestedBy.fleetId }
            : {}),
          ...(requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL'
            ? { vehicleId: { in: requestedBy.accessibleVehicleIds } }
            : {}),
        },
      }),
    ]);

    const moving = Number(movingVehicles[0]?.count ?? 0);

    return {
      total,
      moving,
      idle: total - moving,
      criticalAlerts,
      newThisMonth,
    };
  }

  /**
   * Snapshot bulk de la flotte : tous les vehicules accessibles + leur derniere
   * position connue (lue depuis les colonnes denormalisees `Tracker.last*`).
   *
   * Une seule requete Prisma : pas de N+1, pas de scan de la table positions.
   * Utilise par le frontend pour hydrater immediatement la carte au login.
   */
  async snapshot(requestedBy: RequestedBy): Promise<VehicleSnapshotDto[]> {
    const where: Prisma.VehicleWhereInput = {};

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      where.fleetId = requestedBy.fleetId ?? undefined;
    }

    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      where.id = { in: requestedBy.accessibleVehicleIds };
    }

    const vehicles = await this.prisma.vehicle.findMany({
      where,
      include: { tracker: true, schedule: { select: { enabled: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // Determine quels trackers ont un CUT actif (derniere commande SENT/ACK est CUT sans RESTORE apres)
    const trackerIds = vehicles.map((v) => (v as any).tracker?.id).filter(Boolean) as string[];
    const cutActiveIds = new Set<string>();

    if (trackerIds.length > 0) {
      // Exclure DEVICE_OBSERVED + FAILED ancien (>30 min = historique, plus pertinent)
      const lastCmds = await this.prisma.engineControlCommand.findMany({
        where: {
          trackerId: { in: trackerIds },
          source: { not: 'DEVICE_OBSERVED' },
          OR: [
            { status: { in: [CommandStatus.SENT, CommandStatus.ACKNOWLEDGED] } },
            { status: CommandStatus.FAILED, createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        distinct: ['trackerId'],
        select: { trackerId: true, action: true },
      });
      for (const cmd of lastCmds) {
        if (cmd.action === EngineAction.CUT) cutActiveIds.add(cmd.trackerId);
      }
    }

    return vehicles.map((v) => {
      const t = (v as Vehicle & { tracker: any }).tracker;
      return {
        vehicleId: v.id,
        fleetId: v.fleetId,
        plate: v.plate,
        type: v.type,
        brand: v.brand,
        model: v.model,
        trackerId: t?.id ?? null,
        trackerImei: t?.imei ?? null,
        trackerStatus: (t?.status as 'ONLINE' | 'OFFLINE' | 'IDLE' | undefined) ?? null,
        lastSeenAt: t?.lastSeenAt ? t.lastSeenAt.toISOString() : null,
        lastLat: t?.lastLat ?? null,
        lastLng: t?.lastLng ?? null,
        lastSpeedKmh: t?.lastSpeedKmh ?? null,
        lastHeading: t?.lastHeading ?? null,
        lastIgnition: t?.lastIgnition ?? null,
        lastValid: t?.lastValid ?? null,
        lastPositionAt: t?.lastPositionAt ? t.lastPositionAt.toISOString() : null,
        accConnected: t?.accConnected ?? null,
        engineCutActive: t ? cutActiveIds.has(t.id) : null,
        scheduleEnabled: !!(v as any).schedule?.enabled,
      };
    });
  }
}
