import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CommandStatus, EngineAction, Prisma, UserRole } from '@prisma/client';
import type { Position, Tracker, Vehicle } from '@prisma/client';
import type { CobanPositionFrame, PositionUpdateEvent } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import { GeofencesService } from '../geofences/geofences.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TripsService } from '../trips/trips.service';

/** System user ID for device-observed commands. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Only consider app CUT commands within this window for transition detection. */
const CUT_DETECTION_WINDOW_MS = 5 * 60 * 1000;

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
    private readonly errorLogger: ErrorLogger,
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

    // Resolve ignition from binary field OR acc alarm
    let resolvedIgnition: boolean | undefined = frame.ignition;
    if (resolvedIgnition === undefined) {
      if (frame.alarm === 'acc_on') resolvedIgnition = true;
      else if (frame.alarm === 'acc_off') resolvedIgnition = false;
    }

    // Always update tracker state (ignition + lastSeenAt), even for invalid GPS
    const trackerUpdate: Prisma.TrackerUpdateInput = {
      lastSeenAt: new Date(),
      status: 'ONLINE',
    };

    const ignitionChanged =
      resolvedIgnition !== undefined &&
      tracker.lastKnownIgnition !== null &&
      tracker.lastKnownIgnition !== resolvedIgnition;

    if (resolvedIgnition !== undefined) {
      trackerUpdate.lastKnownIgnition = resolvedIgnition;
      if (ignitionChanged || tracker.lastKnownIgnition === null) {
        trackerUpdate.lastIgnitionChangeAt = new Date();
      }
    }

    const wasOffline = tracker.status !== 'ONLINE';
    await this.prisma.tracker.update({
      where: { id: tracker.id },
      data: trackerUpdate,
    });

    if (wasOffline && tracker.vehicle) {
      this.gateway.emitTrackerStatus(tracker.vehicle.fleetId, {
        trackerId: tracker.id,
        imei: tracker.imei,
        status: 'online',
        at: new Date().toISOString(),
      });
    }

    // Detect ignition transitions for SMS bypass / relay reset
    if (ignitionChanged && tracker.vehicle) {
      this.handleIgnitionTransition(
        tracker as Tracker & { vehicle: Vehicle },
        tracker.lastKnownIgnition!,
        resolvedIgnition!,
      ).catch((err) => {
        this.logger.error('Ignition transition handling failed', err);
        this.errorLogger.record(err instanceof Error ? err : new Error(String(err)), 'positions', { imei: frame.imei, trackerId: tracker.id }).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
      });
    }

    // For invalid GPS: broadcast ignition-only update but skip position persistence
    if (!frame.valid) {
      this.logger.debug(`Invalid GPS fix for ${frame.imei}, skipping position persistence`);
      if (tracker.vehicle && resolvedIgnition !== undefined) {
        // Broadcast ignition update via last known position or minimal event
        const event: PositionUpdateEvent = {
          trackerId: tracker.id,
          vehicleId: tracker.vehicle.id,
          fleetId: tracker.vehicle.fleetId,
          lat: frame.latitude,
          lng: frame.longitude,
          speedKmh: frame.speedKph,
          heading: frame.course ?? 0,
          timestamp: frame.deviceTime.toISOString(),
          ignition: resolvedIgnition,
          valid: false,
        };
        this.gateway.broadcastPosition(tracker.vehicle.fleetId, event);
      }
      return;
    }

    // Persist position with ignition
    await this.prisma.position.create({
      data: {
        trackerId: tracker.id,
        lat: frame.latitude,
        lng: frame.longitude,
        speedKmh: frame.speedKph,
        heading: frame.course ?? 0,
        altitude: frame.altitude,
        valid: frame.valid,
        ignition: resolvedIgnition ?? null,
        timestamp: frame.deviceTime,
      },
    });

    if (tracker.vehicle) {
      const ignitionValue = resolvedIgnition ?? true;
      const event: PositionUpdateEvent = {
        trackerId: tracker.id,
        vehicleId: tracker.vehicle.id,
        fleetId: tracker.vehicle.fleetId,
        lat: frame.latitude,
        lng: frame.longitude,
        speedKmh: frame.speedKph,
        heading: frame.course ?? 0,
        timestamp: frame.deviceTime.toISOString(),
        ignition: ignitionValue,
        valid: frame.valid,
      };
      this.gateway.broadcastPosition(tracker.vehicle.fleetId, event);

      this.geofences.checkViolations(
        tracker.id, frame.latitude, frame.longitude,
        tracker.vehicle.fleetId, tracker.vehicle.id, tracker.imei,
      ).catch((err) => {
        this.logger.error('Geofence check failed', err);
        this.errorLogger.record(err instanceof Error ? err : new Error(String(err)), 'geofences', { imei: frame.imei, trackerId: tracker.id }).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
      });

      this.trips.processPosition({
        trackerId: tracker.id,
        vehicleId: tracker.vehicle.id,
        fleetId: tracker.vehicle.fleetId,
        lat: frame.latitude,
        lng: frame.longitude,
        speedKmh: frame.speedKph,
        timestamp: frame.deviceTime,
        ignition: ignitionValue,
        vehiclePlate: tracker.vehicle.plate,
      }).catch((err) => {
        this.logger.error('Trip processing failed', err);
        this.errorLogger.record(err instanceof Error ? err : new Error(String(err)), 'trips', { imei: frame.imei, trackerId: tracker.id }).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
      });
    }
  }

  /**
   * Detect external engine cuts (SMS) and relay resets by observing ignition transitions.
   * Creates synthetic EngineControlCommand records so the UI stays in sync.
   */
  private async handleIgnitionTransition(
    tracker: Tracker & { vehicle: Vehicle },
    previousIgnition: boolean,
    currentIgnition: boolean,
  ): Promise<void> {
    const fleetId = tracker.vehicle.fleetId;

    if (previousIgnition === true && currentIgnition === false) {
      // Ignition went OFF — is there a recent app CUT command?
      const recentCut = await this.prisma.engineControlCommand.findFirst({
        where: {
          trackerId: tracker.id,
          action: EngineAction.CUT,
          status: { in: [CommandStatus.SENT, CommandStatus.ACKNOWLEDGED] },
          createdAt: { gte: new Date(Date.now() - CUT_DETECTION_WINDOW_MS) },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!recentCut) {
        // No app command → external cut (SMS or direct)
        const cmd = await this.prisma.engineControlCommand.create({
          data: {
            trackerId: tracker.id,
            action: EngineAction.CUT,
            source: 'DEVICE_OBSERVED',
            status: CommandStatus.ACKNOWLEDGED,
            requestedBy: SYSTEM_USER_ID,
            reason: 'Coupure détectée par le boîtier (commande SMS ou externe)',
            ackedAt: new Date(),
          },
        });
        this.gateway.emitEngineCommandUpdate(fleetId, {
          commandId: cmd.id,
          trackerId: tracker.id,
          action: cmd.action,
          status: cmd.status,
          lastError: null,
        });
        this.logger.warn(
          { trackerId: tracker.id, imei: tracker.imei, commandId: cmd.id },
          'External engine CUT detected (SMS or direct)',
        );
      }
    } else if (previousIgnition === false && currentIgnition === true) {
      // Ignition went ON — is there an active CUT without a RESTORE?
      const lastCut = await this.prisma.engineControlCommand.findFirst({
        where: {
          trackerId: tracker.id,
          action: EngineAction.CUT,
          status: { in: [CommandStatus.SENT, CommandStatus.ACKNOWLEDGED] },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (lastCut) {
        // Check for a more recent RESTORE
        const lastRestore = await this.prisma.engineControlCommand.findFirst({
          where: {
            trackerId: tracker.id,
            action: EngineAction.RESTORE,
            status: { in: [CommandStatus.SENT, CommandStatus.ACKNOWLEDGED] },
            createdAt: { gt: lastCut.createdAt },
          },
        });

        if (!lastRestore) {
          // CUT was active but ignition came back → relay reset
          const cmd = await this.prisma.engineControlCommand.create({
            data: {
              trackerId: tracker.id,
              action: EngineAction.RESTORE,
              source: 'DEVICE_OBSERVED',
              status: CommandStatus.ACKNOWLEDGED,
              requestedBy: SYSTEM_USER_ID,
              reason: 'Moteur détecté comme actif (réinitialisation relais probable)',
              ackedAt: new Date(),
            },
          });
          this.gateway.emitEngineCommandUpdate(fleetId, {
            commandId: cmd.id,
            trackerId: tracker.id,
            action: cmd.action,
            status: cmd.status,
            lastError: null,
          });
          this.logger.warn(
            { trackerId: tracker.id, imei: tracker.imei, commandId: cmd.id },
            'Relay reset detected: engine is ON despite active CUT',
          );
        }
      }
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
