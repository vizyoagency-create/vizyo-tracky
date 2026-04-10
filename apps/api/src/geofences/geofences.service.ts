import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AlertType, GeofenceRule, GeofenceType, Prisma, UserRole } from '@prisma/client';
import type { Geofence } from '@prisma/client';
import type { GeofenceViolationEvent } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { CreateGeofenceDto } from './dto/create-geofence.dto';
import type { UpdateGeofenceDto } from './dto/update-geofence.dto';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

interface CachedGeofence {
  id: string;
  name: string;
  fleetId: string;
  rule: GeofenceRule;
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
}

@Injectable()
export class GeofencesService {
  private readonly logger = new Logger(GeofencesService.name);

  private readonly trackerZones = new Map<string, Set<string>>();
  private readonly trackerFirstSeen = new Set<string>();
  private geofenceCache = new Map<string, CachedGeofence[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    private readonly alertsService: AlertsService,
  ) {}

  async create(dto: CreateGeofenceDto, requestedBy: RequestedBy): Promise<Geofence> {
    const fleetId = requestedBy.role === UserRole.SUPER_ADMIN && dto.color
      ? requestedBy.fleetId!
      : requestedBy.fleetId!;

    const geofence = await this.prisma.geofence.create({
      data: {
        fleetId,
        name: dto.name,
        type: GeofenceType.CIRCLE,
        rule: dto.rule,
        centerLat: dto.centerLat,
        centerLng: dto.centerLng,
        radiusMeters: dto.radiusMeters,
        color: dto.color ?? '#10e0a0',
      },
    });

    await this.prisma.$executeRaw`
      UPDATE geofences SET geometry = ST_Buffer(
        ST_MakePoint(${dto.centerLng}, ${dto.centerLat})::geography,
        ${dto.radiusMeters}
      ) WHERE id = ${geofence.id}::uuid
    `;

    this.invalidateCache(fleetId);
    return geofence;
  }

  async findAll(requestedBy: RequestedBy): Promise<Geofence[]> {
    const where: Prisma.GeofenceWhereInput = {};
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      where.fleetId = requestedBy.fleetId ?? undefined;
    }
    return this.prisma.geofence.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, requestedBy: RequestedBy): Promise<Geofence> {
    const geofence = await this.prisma.geofence.findUnique({ where: { id } });
    if (!geofence) throw new NotFoundException('Geofence introuvable');
    if (requestedBy.role !== UserRole.SUPER_ADMIN && geofence.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }
    return geofence;
  }

  async update(id: string, dto: UpdateGeofenceDto, requestedBy: RequestedBy): Promise<Geofence> {
    const existing = await this.findOne(id, requestedBy);

    const data: Prisma.GeofenceUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.rule !== undefined) data.rule = dto.rule;
    if (dto.centerLat !== undefined) data.centerLat = dto.centerLat;
    if (dto.centerLng !== undefined) data.centerLng = dto.centerLng;
    if (dto.radiusMeters !== undefined) data.radiusMeters = dto.radiusMeters;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.active !== undefined) data.active = dto.active;

    const updated = await this.prisma.geofence.update({ where: { id }, data });

    const lat = dto.centerLat ?? existing.centerLat;
    const lng = dto.centerLng ?? existing.centerLng;
    const radius = dto.radiusMeters ?? existing.radiusMeters;

    if (dto.centerLat !== undefined || dto.centerLng !== undefined || dto.radiusMeters !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE geofences SET geometry = ST_Buffer(
          ST_MakePoint(${lng}, ${lat})::geography,
          ${radius}
        ) WHERE id = ${id}::uuid
      `;
    }

    this.invalidateCache(existing.fleetId);
    return updated;
  }

  async remove(id: string, requestedBy: RequestedBy): Promise<void> {
    const geofence = await this.findOne(id, requestedBy);
    await this.prisma.geofence.delete({ where: { id } });
    this.invalidateCache(geofence.fleetId);
  }

  async checkViolations(
    trackerId: string,
    lat: number,
    lng: number,
    fleetId: string,
    vehicleId: string | null,
    trackerImei: string,
  ): Promise<void> {
    const zones = await this.getActiveZones(fleetId);
    if (zones.length === 0) return;

    const insideNow = new Set<string>();
    for (const zone of zones) {
      const dist = this.haversineMeters(lat, lng, zone.centerLat, zone.centerLng);
      if (dist <= zone.radiusMeters) {
        insideNow.add(zone.id);
      }
    }

    if (!this.trackerFirstSeen.has(trackerId)) {
      this.trackerFirstSeen.add(trackerId);
      this.trackerZones.set(trackerId, insideNow);
      return;
    }

    const wasInside = this.trackerZones.get(trackerId) ?? new Set<string>();

    for (const zone of zones) {
      const nowIn = insideNow.has(zone.id);
      const wasIn = wasInside.has(zone.id);

      if (nowIn && !wasIn) {
        if (zone.rule === 'ENTER' || zone.rule === 'BOTH') {
          await this.emitViolation(zone, 'ENTER', trackerId, vehicleId, fleetId, lat, lng, trackerImei);
        }
      } else if (!nowIn && wasIn) {
        if (zone.rule === 'EXIT' || zone.rule === 'BOTH') {
          await this.emitViolation(zone, 'EXIT', trackerId, vehicleId, fleetId, lat, lng, trackerImei);
        }
      }
    }

    this.trackerZones.set(trackerId, insideNow);
  }

  private async emitViolation(
    zone: CachedGeofence,
    violation: 'ENTER' | 'EXIT',
    trackerId: string,
    vehicleId: string | null,
    fleetId: string,
    lat: number,
    lng: number,
    trackerImei: string,
  ): Promise<void> {
    this.logger.warn(`[GEOFENCE] ${violation} zone "${zone.name}" by tracker ${trackerImei}`);

    const alertType = violation === 'ENTER' ? AlertType.GEOFENCE_ENTER : AlertType.GEOFENCE_EXIT;
    const title = violation === 'ENTER'
      ? `Entree dans la zone "${zone.name}"`
      : `Sortie de la zone "${zone.name}"`;

    await this.prisma.alert.create({
      data: {
        fleetId,
        vehicleId,
        trackerId,
        type: alertType,
        severity: 'WARNING',
        title,
        message: `Zone: ${zone.name} (${zone.radiusMeters}m)`,
        latitude: lat,
        longitude: lng,
      },
    }).then((alert) => {
      this.gateway.broadcastAlert({ ...alert, vehicle: null, tracker: null });
    }).catch((err) => this.logger.error('Failed to create geofence alert', err));

    const event: GeofenceViolationEvent = {
      geofenceId: zone.id,
      geofenceName: zone.name,
      trackerId,
      vehicleId,
      fleetId,
      violation,
      lat,
      lng,
      at: new Date().toISOString(),
    };
    this.gateway.broadcastGeofenceViolation(fleetId, event);
  }

  private async getActiveZones(fleetId: string): Promise<CachedGeofence[]> {
    const cached = this.geofenceCache.get(fleetId);
    if (cached) return cached;

    const zones = await this.prisma.geofence.findMany({
      where: { fleetId, active: true },
      select: { id: true, name: true, fleetId: true, rule: true, centerLat: true, centerLng: true, radiusMeters: true },
    });

    this.geofenceCache.set(fleetId, zones);
    return zones;
  }

  private invalidateCache(fleetId: string): void {
    this.geofenceCache.delete(fleetId);
  }

  private haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
