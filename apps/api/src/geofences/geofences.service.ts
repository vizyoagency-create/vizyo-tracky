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
import { distanceMeters } from '../common/utils/haversine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { isInsideCorridor } from './corridor-geometry';
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
  type: GeofenceType;
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
  /** Sprint F.2 V1.4 : sommets pour les geofences POLYGON. */
  polygonPoints: Array<{ lat: number; lng: number }> | null;
  /** V1.5 (Sprint N) : polyligne pour les geofences CORRIDOR + largeur en metres. */
  corridorPoints: Array<{ lat: number; lng: number }> | null;
  corridorWidthM: number | null;
  /** V1.5 (Sprint N) : ciblage explicite par vehicule. Vide = applique a tous. */
  vehicleTargets: Set<string>;
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
    private readonly errorLogger: ErrorLogger,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async create(dto: CreateGeofenceDto, requestedBy: RequestedBy): Promise<Geofence> {
    // Resolution du fleetId :
    // - utilisateur normal (FLEET_ADMIN/MANAGER) : utilise sa propre flotte.
    // - SUPER_ADMIN sans flotte assignee : par defaut la premiere flotte de la
    //   base. Permet a l'admin technique de creer des geofences en dev/seed
    //   sans imposer de selection UI (Sprint F.2 V1.4).
    let fleetId: string;
    if (requestedBy.fleetId) {
      fleetId = requestedBy.fleetId;
    } else if (requestedBy.role === UserRole.SUPER_ADMIN) {
      const firstFleet = await this.prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' } });
      if (!firstFleet) throw new ForbiddenException('Aucune flotte existante a laquelle rattacher la geofence');
      fleetId = firstFleet.id;
    } else {
      throw new ForbiddenException('Aucune flotte associee a votre compte');
    }

    const type = dto.type ?? GeofenceType.CIRCLE;
    if (type === GeofenceType.POLYGON && (!dto.polygonPoints || dto.polygonPoints.length < 3)) {
      throw new ForbiddenException('Une geofence POLYGON doit avoir au moins 3 sommets');
    }
    if (type === GeofenceType.CORRIDOR && (!dto.corridorPoints || dto.corridorPoints.length < 2)) {
      throw new ForbiddenException('Une geofence CORRIDOR doit avoir au moins 2 points');
    }

    const geofence = await this.prisma.geofence.create({
      data: {
        fleetId,
        name: dto.name,
        type,
        rule: dto.rule,
        centerLat: dto.centerLat,
        centerLng: dto.centerLng,
        radiusMeters: dto.radiusMeters,
        color: dto.color ?? '#10e0a0',
        polygonPoints: type === GeofenceType.POLYGON ? (dto.polygonPoints as unknown as Prisma.InputJsonValue) : undefined,
        corridorPoints: type === GeofenceType.CORRIDOR ? (dto.corridorPoints as unknown as Prisma.InputJsonValue) : undefined,
        corridorWidthM: type === GeofenceType.CORRIDOR ? (dto.corridorWidthM ?? 100) : undefined,
      },
    });

    this.prisma.$executeRaw`
      UPDATE geofences SET geometry = ST_Buffer(
        ST_MakePoint(${dto.centerLng}, ${dto.centerLat})::geography,
        ${dto.radiusMeters}
      ) WHERE id = ${geofence.id}::uuid
    `.catch((err) => {
      this.logger.warn('Failed to update PostGIS geometry (non-blocking)', err.message);
      this.errorLogger.record(err instanceof Error ? err : new Error(String(err)), 'geofences').catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
    });

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
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.rule !== undefined) data.rule = dto.rule;
    if (dto.centerLat !== undefined) data.centerLat = dto.centerLat;
    if (dto.centerLng !== undefined) data.centerLng = dto.centerLng;
    if (dto.radiusMeters !== undefined) data.radiusMeters = dto.radiusMeters;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.polygonPoints !== undefined) {
      data.polygonPoints = dto.polygonPoints as unknown as Prisma.InputJsonValue;
    }

    const updated = await this.prisma.geofence.update({ where: { id }, data });

    const lat = dto.centerLat ?? existing.centerLat;
    const lng = dto.centerLng ?? existing.centerLng;
    const radius = dto.radiusMeters ?? existing.radiusMeters;

    if (dto.centerLat !== undefined || dto.centerLng !== undefined || dto.radiusMeters !== undefined) {
      this.prisma.$executeRaw`
        UPDATE geofences SET geometry = ST_Buffer(
          ST_MakePoint(${lng}, ${lat})::geography,
          ${radius}
        ) WHERE id = ${id}::uuid
      `.catch((err) => {
      this.logger.warn('Failed to update PostGIS geometry (non-blocking)', err.message);
      this.errorLogger.record(err instanceof Error ? err : new Error(String(err)), 'geofences').catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
    });
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
      // V1.5 (Sprint N) — ciblage explicite : si la zone a des vehicules
      // listes ET que le vehicule courant n'est pas dedans, on skippe.
      if (zone.vehicleTargets.size > 0) {
        if (!vehicleId || !zone.vehicleTargets.has(vehicleId)) continue;
      }

      let inside = false;
      if (zone.type === GeofenceType.POLYGON && zone.polygonPoints && zone.polygonPoints.length >= 3) {
        inside = pointInPolygon(lat, lng, zone.polygonPoints);
      } else if (zone.type === GeofenceType.CORRIDOR && zone.corridorPoints && zone.corridorWidthM) {
        // V1.5 (Sprint N) — pour un corridor, "inside" signifie "dans le buffer
        // perpendiculaire". L'alerte ENTER/EXIT s'interprete donc comme
        // "rentre dans le corridor" / "sort du corridor".
        inside = isInsideCorridor({ lat, lng }, zone.corridorPoints, zone.corridorWidthM);
      } else {
        const dist = distanceMeters(lat, lng, zone.centerLat, zone.centerLng);
        inside = dist <= zone.radiusMeters;
      }
      if (inside) insideNow.add(zone.id);
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
      include: { vehicle: true },
    }).then((alert) => {
      this.gateway.broadcastAlert({ ...alert, tracker: null });
      // V1.5 (Sprint M) — dispatch externe (push / email / WhatsApp).
      this.dispatch.dispatchAlert(alert).catch((err) => {
        this.logger.warn(`Notification dispatch failed for geofence alert ${alert.id}: ${err instanceof Error ? err.message : err}`);
      });
    }).catch((err) => {
      this.logger.error('Failed to create geofence alert', err);
      this.errorLogger.record(err instanceof Error ? err : new Error(String(err)), 'geofences', { trackerId, vehicleId: vehicleId ?? undefined }).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
    });

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
    const existing = this.geofenceCache.get(fleetId);
    if (existing) return existing;

    const zones = await this.prisma.geofence.findMany({
      where: { fleetId, active: true },
      select: {
        id: true, name: true, fleetId: true, rule: true, type: true,
        centerLat: true, centerLng: true, radiusMeters: true, polygonPoints: true,
        corridorPoints: true, corridorWidthM: true,
        vehicleTargets: { select: { vehicleId: true } },
      },
    });

    const mapped: CachedGeofence[] = zones.map((z) => ({
      id: z.id,
      name: z.name,
      fleetId: z.fleetId,
      rule: z.rule,
      type: z.type,
      centerLat: z.centerLat,
      centerLng: z.centerLng,
      radiusMeters: z.radiusMeters,
      polygonPoints: Array.isArray(z.polygonPoints)
        ? (z.polygonPoints as Array<{ lat: number; lng: number }>)
        : null,
      corridorPoints: Array.isArray(z.corridorPoints)
        ? (z.corridorPoints as Array<{ lat: number; lng: number }>)
        : null,
      corridorWidthM: z.corridorWidthM,
      vehicleTargets: new Set(z.vehicleTargets.map((vt) => vt.vehicleId)),
    }));
    this.geofenceCache.set(fleetId, mapped);
    return mapped;
  }

  private invalidateCache(fleetId: string): void {
    this.geofenceCache.delete(fleetId);
  }

  /**
   * V1.5 (Sprint N) — Import bulk depuis un GeoJSON FeatureCollection.
   * Mapping : Polygon → POLYGON, LineString → CORRIDOR, Point + radius → CIRCLE.
   * Properties supportes : name, color, rule, widthM (corridor), radius (point).
   */
  async importGeoJson(
    json: unknown,
    requestedBy: RequestedBy,
  ): Promise<{ created: number; skipped: number }> {
    const { parseGeoJsonToDrafts } = await import('./corridor-geometry');
    const drafts = parseGeoJsonToDrafts(json);
    if (drafts.length === 0) return { created: 0, skipped: 0 };

    const fleetId = requestedBy.fleetId
      ?? (requestedBy.role === UserRole.SUPER_ADMIN
        ? (await this.prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' } }))?.id
        : null);
    if (!fleetId) throw new ForbiddenException('Aucune flotte associee');

    let created = 0;
    let skipped = 0;
    for (const d of drafts) {
      try {
        await this.prisma.geofence.create({
          data: {
            fleetId,
            name: d.name,
            type: d.type as GeofenceType,
            rule: d.rule as GeofenceRule,
            centerLat: d.centerLat,
            centerLng: d.centerLng,
            radiusMeters: d.radiusMeters,
            color: d.color ?? '#10e0a0',
            polygonPoints: d.polygonPoints as unknown as Prisma.InputJsonValue,
            corridorPoints: d.corridorPoints as unknown as Prisma.InputJsonValue,
            corridorWidthM: d.corridorWidthM ?? undefined,
          },
        });
        created++;
      } catch (err) {
        this.logger.warn(`Skip GeoJSON feature "${d.name}": ${(err as Error).message}`);
        skipped++;
      }
    }
    this.invalidateCache(fleetId);
    return { created, skipped };
  }

  /**
   * V1.5 (Sprint N) — Cible une geofence sur une liste de vehicules.
   * Replace le set de targets (passer [] pour repasser en mode global).
   */
  async setVehicleTargets(
    geofenceId: string,
    vehicleIds: string[],
    requestedBy: RequestedBy,
  ): Promise<{ vehicleIds: string[] }> {
    const geofence = await this.prisma.geofence.findUnique({ where: { id: geofenceId } });
    if (!geofence) throw new NotFoundException('Geofence introuvable');
    if (requestedBy.role !== UserRole.SUPER_ADMIN && geofence.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }

    if (vehicleIds.length > 0) {
      const valid = await this.prisma.vehicle.findMany({
        where: { id: { in: vehicleIds }, fleetId: geofence.fleetId },
        select: { id: true },
      });
      const validIds = new Set(valid.map((v) => v.id));
      vehicleIds = vehicleIds.filter((id) => validIds.has(id));
    }

    await this.prisma.$transaction([
      this.prisma.geofenceVehicle.deleteMany({ where: { geofenceId } }),
      ...(vehicleIds.length > 0
        ? [this.prisma.geofenceVehicle.createMany({
            data: vehicleIds.map((vehicleId) => ({ geofenceId, vehicleId })),
          })]
        : []),
    ]);

    this.invalidateCache(geofence.fleetId);
    return { vehicleIds };
  }

  async getVehicleTargets(geofenceId: string, requestedBy: RequestedBy): Promise<{ vehicleIds: string[] }> {
    const geofence = await this.prisma.geofence.findUnique({ where: { id: geofenceId } });
    if (!geofence) throw new NotFoundException('Geofence introuvable');
    if (requestedBy.role !== UserRole.SUPER_ADMIN && geofence.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }
    const targets = await this.prisma.geofenceVehicle.findMany({
      where: { geofenceId },
      select: { vehicleId: true },
    });
    return { vehicleIds: targets.map((t) => t.vehicleId) };
  }

}

/**
 * Test point-in-polygon par ray casting.
 * Le polygone est ferme implicitement (le dernier sommet est connecte au premier).
 * En projection lat/lng plane — acceptable a l'echelle d'une zone urbaine
 * (les distances en degres sont quasi-lineaires sur quelques km).
 */
function pointInPolygon(lat: number, lng: number, ring: Array<{ lat: number; lng: number }>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]!.lng, yi = ring[i]!.lat;
    const xj = ring[j]!.lng, yj = ring[j]!.lat;
    const intersect = ((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
