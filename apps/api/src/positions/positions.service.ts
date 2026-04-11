import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type { Position } from '@prisma/client';
import type { CobanPositionFrame, PositionUpdateEvent } from '@vizyo/tracky-shared';
import { GeofencesService } from '../geofences/geofences.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TripsService } from '../trips/trips.service';

interface RequestedBy {
  role: UserRole | string;
  fleetId: string | null;
}

@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    private readonly geofences: GeofencesService,
    private readonly trips: TripsService,
  ) {}

  async ingest(frame: CobanPositionFrame): Promise<void> {
    const tracker = await this.prisma.tracker.findUnique({
      where: { imei: frame.imei },
      include: { vehicle: true },
    });

    if (!tracker) {
      this.logger.warn(`Position for unknown IMEI ${frame.imei}, skipping`);
      return;
    }

    if (!frame.valid) {
      this.logger.debug(`Invalid GPS fix for ${frame.imei}, skipping persistence`);
      return;
    }

    await this.prisma.position.create({
      data: {
        trackerId: tracker.id,
        lat: frame.latitude,
        lng: frame.longitude,
        speedKmh: frame.speedKph,
        heading: frame.course ?? 0,
        altitude: frame.altitude,
        valid: frame.valid,
        timestamp: frame.deviceTime,
      },
    });

    const wasOffline = tracker.status !== 'ONLINE';
    await this.prisma.tracker.update({
      where: { id: tracker.id },
      data: { lastSeenAt: new Date(), status: 'ONLINE' },
    });

    if (wasOffline && tracker.vehicle) {
      this.gateway.emitTrackerStatus(tracker.vehicle.fleetId, {
        trackerId: tracker.id,
        imei: tracker.imei,
        status: 'online',
        at: new Date().toISOString(),
      });
    }

    if (tracker.vehicle) {
      const event: PositionUpdateEvent = {
        trackerId: tracker.id,
        vehicleId: tracker.vehicle.id,
        fleetId: tracker.vehicle.fleetId,
        lat: frame.latitude,
        lng: frame.longitude,
        speedKmh: frame.speedKph,
        heading: frame.course ?? 0,
        timestamp: frame.deviceTime.toISOString(),
        ignition: frame.ignition ?? true,
        valid: frame.valid,
      };
      this.gateway.broadcastPosition(tracker.vehicle.fleetId, event);

      this.geofences.checkViolations(
        tracker.id, frame.latitude, frame.longitude,
        tracker.vehicle.fleetId, tracker.vehicle.id, tracker.imei,
      ).catch((err) => this.logger.error('Geofence check failed', err));

      this.trips.processPosition({
        trackerId: tracker.id,
        vehicleId: tracker.vehicle.id,
        fleetId: tracker.vehicle.fleetId,
        lat: frame.latitude,
        lng: frame.longitude,
        speedKmh: frame.speedKph,
        timestamp: frame.deviceTime,
        ignition: frame.ignition ?? true,
        vehiclePlate: tracker.vehicle.plate,
      }).catch((err) => this.logger.error('Trip processing failed', err));
    }
  }

  async list(
    requestedBy: RequestedBy,
    filters: {
      trackerId?: string;
      vehicleId?: string;
      limit?: string;
      from?: string;
      to?: string;
      cursor?: string;
    },
  ): Promise<{ items: Position[]; nextCursor: string | null }> {
    let trackerId = filters.trackerId;

    if (!trackerId && filters.vehicleId) {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: filters.vehicleId },
        include: { tracker: true },
      });
      if (!vehicle) throw new NotFoundException('Vehicule introuvable');
      if (requestedBy.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Acces refuse');
      }
      if (!vehicle.tracker) return { items: [], nextCursor: null };
      trackerId = vehicle.tracker.id;
    }

    if (!trackerId) {
      throw new BadRequestException('trackerId ou vehicleId requis');
    }

    const tracker = await this.prisma.tracker.findUnique({
      where: { id: trackerId },
      include: { vehicle: true },
    });
    if (!tracker) throw new NotFoundException('Tracker introuvable');

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!tracker.vehicle || tracker.vehicle.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Acces refuse');
      }
    }

    const where: Prisma.PositionWhereInput = { trackerId };
    if (filters.from || filters.to) {
      where.timestamp = {};
      if (filters.from) (where.timestamp as any).gte = new Date(filters.from);
      if (filters.to) (where.timestamp as any).lte = new Date(filters.to);
    }

    const limit = Math.min(filters.limit ? parseInt(filters.limit, 10) : 100, 500);
    const items = await this.prisma.position.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }
}
