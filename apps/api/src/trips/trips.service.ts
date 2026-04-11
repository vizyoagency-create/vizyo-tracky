import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, UserRole } from '@prisma/client';
import type { Trip } from '@prisma/client';
import type { TripCompletedEvent, TripStartedEvent } from '@vizyo/tracky-shared';
import { distanceMeters } from '../common/utils/haversine';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TripSegmenterService } from './trip-segmenter.service';
import {
  TRIP_MIN_DISTANCE_METERS,
  TRIP_SPEED_THRESHOLD_KMH,
  TRIP_STOP_TIMEOUT_MS,
  TRIP_MOVING_CONFIRM_MS,
} from './trip-segmenter.constants';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
  accessibleVehicleIds?: string[] | 'ALL';
}

interface OpenTripState {
  tripId: string;
  trackerId: string;
  vehicleId: string;
  fleetId: string;
  startedAt: Date;
  startLat: number;
  startLng: number;
  lastLat: number;
  lastLng: number;
  lastTimestamp: Date;
  dist: number;
  maxSpeed: number;
  speedSum: number;
  positionCount: number;
  polyPoints: Array<{ lat: number; lng: number }>;
  zeroSpeedSince: Date | null;
  vehiclePlate?: string;
}

interface MovingCandidate {
  firstMovingAt: Date;
  trackerId: string;
  vehicleId: string;
  fleetId: string;
  lat: number;
  lng: number;
  vehiclePlate?: string;
}

@Injectable()
export class TripsService implements OnModuleInit {
  private readonly logger = new Logger(TripsService.name);
  private readonly openTrips = new Map<string, OpenTripState>();
  private readonly movingCandidates = new Map<string, MovingCandidate>();
  private ready = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    private readonly segmenter: TripSegmenterService,
  ) {}

  async onModuleInit(): Promise<void> {
    const openDbTrips = await this.prisma.trip.findMany({
      where: { endedAt: null },
      include: { vehicle: true },
    });

    for (const trip of openDbTrips) {
      this.openTrips.set(trip.trackerId ?? '', {
        tripId: trip.id,
        trackerId: trip.trackerId ?? '',
        vehicleId: trip.vehicleId,
        fleetId: trip.fleetId ?? '',
        startedAt: trip.startedAt,
        startLat: trip.startLat,
        startLng: trip.startLng,
        lastLat: trip.endLat ?? trip.startLat,
        lastLng: trip.endLng ?? trip.startLng,
        lastTimestamp: trip.startedAt,
        dist: trip.distanceMeters,
        maxSpeed: trip.maxSpeed,
        speedSum: trip.avgSpeed * trip.positionCount,
        positionCount: trip.positionCount,
        polyPoints: [],
        zeroSpeedSince: null,
        vehiclePlate: (trip.vehicle as any)?.plate,
      });
    }

    this.ready = true;
    this.logger.log(`Trip recovery: ${openDbTrips.length} open trips loaded`);
  }

  async processPosition(data: {
    trackerId: string;
    vehicleId: string;
    fleetId: string;
    lat: number;
    lng: number;
    speedKmh: number;
    timestamp: Date;
    ignition: boolean;
    vehiclePlate?: string;
  }): Promise<void> {
    if (!this.ready) return;

    const state = this.openTrips.get(data.trackerId);

    if (!state) {
      if (data.ignition === false) {
        this.movingCandidates.delete(data.trackerId);
        return;
      }

      if (data.speedKmh > TRIP_SPEED_THRESHOLD_KMH) {
        const candidate = this.movingCandidates.get(data.trackerId);
        if (!candidate) {
          this.movingCandidates.set(data.trackerId, {
            firstMovingAt: data.timestamp,
            trackerId: data.trackerId,
            vehicleId: data.vehicleId,
            fleetId: data.fleetId,
            lat: data.lat,
            lng: data.lng,
            vehiclePlate: data.vehiclePlate,
          });
        } else if (data.timestamp.getTime() - candidate.firstMovingAt.getTime() >= TRIP_MOVING_CONFIRM_MS) {
          await this.startTrip(data);
          this.movingCandidates.delete(data.trackerId);
        }
      } else {
        this.movingCandidates.delete(data.trackerId);
      }
      return;
    }

    const d = distanceMeters(state.lastLat, state.lastLng, data.lat, data.lng);
    state.dist += d;
    state.maxSpeed = Math.max(state.maxSpeed, data.speedKmh);
    state.speedSum += data.speedKmh;
    state.positionCount++;
    state.lastLat = data.lat;
    state.lastLng = data.lng;
    state.lastTimestamp = data.timestamp;
    if (state.polyPoints.length < 100) {
      state.polyPoints.push({ lat: data.lat, lng: data.lng });
    }

    if (data.ignition === false) {
      await this.finalizeTrip(state, data.timestamp, 'ignition');
      return;
    }

    if (data.speedKmh === 0) {
      if (!state.zeroSpeedSince) {
        state.zeroSpeedSince = data.timestamp;
      } else if (data.timestamp.getTime() - state.zeroSpeedSince.getTime() >= TRIP_STOP_TIMEOUT_MS) {
        await this.finalizeTrip(state, state.zeroSpeedSince, 'speed');
      }
    } else {
      state.zeroSpeedSince = null;
    }
  }

  @Cron('*/60 * * * * *')
  async checkTimeouts(): Promise<void> {
    if (!this.ready) return;
    const now = Date.now();
    for (const [trackerId, state] of this.openTrips) {
      if (now - state.lastTimestamp.getTime() > TRIP_STOP_TIMEOUT_MS) {
        this.logger.warn(`Trip timeout for tracker ${trackerId}, closing`);
        await this.finalizeTrip(state, state.lastTimestamp, 'timeout');
      }
    }
  }

  private async startTrip(data: {
    trackerId: string;
    vehicleId: string;
    fleetId: string;
    lat: number;
    lng: number;
    timestamp: Date;
    speedKmh: number;
    vehiclePlate?: string;
  }): Promise<void> {
    const trip = await this.prisma.trip.create({
      data: {
        vehicleId: data.vehicleId,
        trackerId: data.trackerId,
        fleetId: data.fleetId,
        startedAt: data.timestamp,
        startLat: data.lat,
        startLng: data.lng,
      },
    });

    this.openTrips.set(data.trackerId, {
      tripId: trip.id,
      trackerId: data.trackerId,
      vehicleId: data.vehicleId,
      fleetId: data.fleetId,
      startedAt: data.timestamp,
      startLat: data.lat,
      startLng: data.lng,
      lastLat: data.lat,
      lastLng: data.lng,
      lastTimestamp: data.timestamp,
      dist: 0,
      maxSpeed: data.speedKmh,
      speedSum: data.speedKmh,
      positionCount: 1,
      polyPoints: [{ lat: data.lat, lng: data.lng }],
      zeroSpeedSince: null,
      vehiclePlate: data.vehiclePlate,
    });

    const event: TripStartedEvent = {
      tripId: trip.id,
      vehicleId: data.vehicleId,
      trackerId: data.trackerId,
      fleetId: data.fleetId,
      startedAt: data.timestamp.toISOString(),
      startLat: data.lat,
      startLng: data.lng,
    };
    this.gateway.emitTripStarted(data.fleetId, event);
    this.logger.log(`Trip started: ${trip.id} for tracker ${data.trackerId}`);
  }

  private async finalizeTrip(state: OpenTripState, endTime: Date, source: string): Promise<void> {
    if (state.dist < TRIP_MIN_DISTANCE_METERS) {
      await this.prisma.trip.delete({ where: { id: state.tripId } }).catch(() => {});
      this.openTrips.delete(state.trackerId);
      return;
    }

    const dur = Math.round((endTime.getTime() - state.startedAt.getTime()) / 1000);
    const avg = state.positionCount > 0 ? Math.round((state.speedSum / state.positionCount) * 100) / 100 : 0;

    await this.prisma.trip.update({
      where: { id: state.tripId },
      data: {
        endedAt: endTime,
        endLat: state.lastLat,
        endLng: state.lastLng,
        durationSeconds: dur,
        distanceMeters: Math.round(state.dist),
        distanceKm: Math.round(state.dist / 10) / 100,
        maxSpeed: Math.round(state.maxSpeed * 100) / 100,
        avgSpeed: avg,
        positionCount: state.positionCount,
        segmentationSource: source,
        polyline: JSON.stringify(state.polyPoints),
      },
    });

    const event: TripCompletedEvent = {
      tripId: state.tripId,
      vehicleId: state.vehicleId,
      trackerId: state.trackerId,
      fleetId: state.fleetId,
      startedAt: state.startedAt.toISOString(),
      endedAt: endTime.toISOString(),
      durationSeconds: dur,
      distanceMeters: Math.round(state.dist),
      maxSpeed: Math.round(state.maxSpeed * 100) / 100,
      avgSpeed: avg,
    };
    this.gateway.emitTripCompleted(state.fleetId, event);
    this.openTrips.delete(state.trackerId);
    this.logger.log(`Trip completed: ${state.tripId} (${source}, ${Math.round(state.dist)}m, ${dur}s)`);
  }

  async list(
    requestedBy: RequestedBy,
    filters: { vehicleId?: string; from?: string; to?: string; limit?: string; cursor?: string },
  ): Promise<{ items: Trip[]; nextCursor: string | null }> {
    const where: Prisma.TripWhereInput = { endedAt: { not: null } };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      where.fleetId = requestedBy.fleetId;
    }
    // Filtrage par accès véhicules
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      where.vehicleId = filters.vehicleId
        ? (requestedBy.accessibleVehicleIds.includes(filters.vehicleId) ? filters.vehicleId : 'DENIED')
        : { in: requestedBy.accessibleVehicleIds };
    } else if (filters.vehicleId) {
      where.vehicleId = filters.vehicleId;
    }
    if (filters.from || filters.to) {
      where.startedAt = {};
      if (filters.from) (where.startedAt as any).gte = new Date(filters.from);
      if (filters.to) (where.startedAt as any).lte = new Date(filters.to);
    }

    const limit = Math.min(filters.limit ? parseInt(filters.limit, 10) : 20, 100);
    const items = await this.prisma.trip.findMany({
      where,
      include: { vehicle: true },
      orderBy: { startedAt: 'desc' },
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1]!.id : null };
  }

  async findOne(id: string, requestedBy: RequestedBy): Promise<Trip> {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: { vehicle: true },
    });
    if (!trip) throw new NotFoundException('Trajet introuvable');
    if (requestedBy.role !== UserRole.SUPER_ADMIN && trip.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }
    return trip;
  }

  async dailySummary(
    requestedBy: RequestedBy,
    filters: { vehicleId?: string; from?: string; to?: string },
  ): Promise<Array<{ date: string; tripCount: number; totalDistanceMeters: number; totalDurationSeconds: number; maxSpeed: number }>> {
    const where: Prisma.TripWhereInput = { endedAt: { not: null } };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) where.fleetId = requestedBy.fleetId;
    if (filters.vehicleId) where.vehicleId = filters.vehicleId;
    if (filters.from) where.startedAt = { ...(where.startedAt as any ?? {}), gte: new Date(filters.from) };
    if (filters.to) where.startedAt = { ...(where.startedAt as any ?? {}), lte: new Date(filters.to) };

    const trips = await this.prisma.trip.findMany({ where, orderBy: { startedAt: 'asc' } });

    const byDate = new Map<string, { count: number; dist: number; dur: number; maxSpd: number }>();
    for (const t of trips) {
      const date = t.startedAt.toISOString().slice(0, 10);
      const entry = byDate.get(date) ?? { count: 0, dist: 0, dur: 0, maxSpd: 0 };
      entry.count++;
      entry.dist += t.distanceMeters;
      entry.dur += t.durationSeconds;
      entry.maxSpd = Math.max(entry.maxSpd, t.maxSpeed);
      byDate.set(date, entry);
    }

    return Array.from(byDate.entries()).map(([date, e]) => ({
      date,
      tripCount: e.count,
      totalDistanceMeters: Math.round(e.dist),
      totalDurationSeconds: e.dur,
      maxSpeed: Math.round(e.maxSpd * 100) / 100,
    }));
  }

  async recompute(
    requestedBy: RequestedBy,
    dto: { vehicleId: string; from: string; to: string },
  ): Promise<{ deleted: number; created: number }> {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    if (new Date(dto.to) > tenMinAgo) {
      throw new BadRequestException('Impossible de recalculer une periode incluant les 10 dernieres minutes');
    }

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: dto.vehicleId },
      include: { tracker: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicule introuvable');
    if (requestedBy.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }
    if (!vehicle.tracker) throw new BadRequestException('Vehicule sans tracker');

    this.openTrips.delete(vehicle.tracker.id);

    const fromDate = new Date(dto.from);
    const toDate = new Date(dto.to);

    const { count: deleted } = await this.prisma.trip.deleteMany({
      where: {
        vehicleId: dto.vehicleId,
        startedAt: { gte: fromDate, lte: toDate },
      },
    });

    const positions = await this.prisma.position.findMany({
      where: {
        trackerId: vehicle.tracker.id,
        timestamp: { gte: fromDate, lte: toDate },
      },
      orderBy: { timestamp: 'asc' },
    });

    const drafts = this.segmenter.segmentPositions(
      positions.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        speedKmh: p.speedKmh,
        timestamp: p.timestamp,
        ignition: undefined,
      })),
    );

    let created = 0;
    for (const draft of drafts) {
      await this.prisma.trip.create({
        data: {
          vehicleId: dto.vehicleId,
          trackerId: vehicle.tracker.id,
          fleetId: vehicle.fleetId,
          startedAt: draft.startedAt,
          endedAt: draft.endedAt,
          startLat: draft.startLat,
          startLng: draft.startLng,
          endLat: draft.endLat,
          endLng: draft.endLng,
          durationSeconds: draft.durationSeconds,
          distanceMeters: draft.distanceMeters,
          distanceKm: draft.distanceMeters / 1000,
          maxSpeed: draft.maxSpeed,
          avgSpeed: draft.avgSpeed,
          positionCount: draft.positionCount,
          segmentationSource: 'recompute',
          polyline: JSON.stringify(draft.positions),
        },
      });
      created++;
    }

    return { deleted, created };
  }
}
