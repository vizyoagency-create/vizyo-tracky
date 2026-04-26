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
import { isValidLatLng, WS_EVENTS } from '@vizyo/tracky-shared';
import { GeofencesService } from '../geofences/geofences.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { PositionBroadcastBuffer } from '../realtime/position-broadcast-buffer.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TrackerFixModeService } from '../tracker-fix-mode/tracker-fix-mode.service';
import { TripsService } from '../trips/trips.service';
import { PositionSamplingService } from './position-sampling.service';

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
    private readonly sampling: PositionSamplingService,
    private readonly broadcastBuffer: PositionBroadcastBuffer,
    private readonly fixMode: TrackerFixModeService,
  ) {}

  async ingest(frame: CobanPositionFrame): Promise<void> {
    const tracker = await this.prisma.tracker.findUnique({
      where: { imei: frame.imei },
      include: { vehicle: { include: { fleet: true } } },
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

    // V1.4 (Sprint 4 — gps-sanity) : rejet defensif des coordonnees hors-bornes
    // ou a Null Island, meme si le protocole les marque valid:true.
    if (!isValidLatLng(frame.latitude, frame.longitude)) {
      this.logger.warn(
        `Position rejetee pour ${frame.imei} : lat/lng hors-bornes ou Null Island ` +
          `(${frame.latitude}, ${frame.longitude})`,
      );
      return;
    }

    // Always update tracker state (ignition + lastSeenAt), even for invalid GPS.
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

    // V1.4 (Sprint 1 — hydratation au login) : denormalisation derniere position
    // connue. Mise a jour seulement quand la trame GPS est valide pour ne pas
    // ecraser une position fraiche par un fix degrade.
    if (frame.valid) {
      trackerUpdate.lastLat = frame.latitude;
      trackerUpdate.lastLng = frame.longitude;
      trackerUpdate.lastSpeedKmh = frame.speedKph;
      trackerUpdate.lastHeading = frame.course ?? 0;
      trackerUpdate.lastIgnition = resolvedIgnition ?? null;
      trackerUpdate.lastValid = frame.valid;
      trackerUpdate.lastPositionAt = frame.deviceTime;
    }

    // V1.5 (Sprint H1) — sampling adaptatif. Calcule sur les trames valides
    // uniquement (les invalides ne sont jamais persistees, sampling sans objet).
    // L'outcome alimente trackerUpdate (lastWriteAt + lastSampledState) et
    // pilote le `prisma.position.create` plus bas. Le broadcast WS reste
    // integral quel que soit l'outcome (UX-first).
    let samplingOutcome: ReturnType<PositionSamplingService['decide']> | null = null;
    let samplingState: ReturnType<PositionSamplingService['classify']>['state'] | null = null;
    if (frame.valid) {
      const adaptiveEnabled = tracker.vehicle?.fleet?.adaptiveSamplingEnabled ?? true;
      const { state, distanceM } = this.sampling.classify({
        speedKmh: frame.speedKph,
        ignition: resolvedIgnition,
        lat: frame.latitude,
        lng: frame.longitude,
        prevLat: tracker.lastLat,
        prevLng: tracker.lastLng,
      });
      samplingState = state;
      samplingOutcome = this.sampling.decide(tracker, state, distanceM, adaptiveEnabled);

      if (samplingOutcome.shouldInsert) {
        trackerUpdate.lastWriteAt = new Date();
        trackerUpdate.lastSampledState = samplingOutcome.state;
      }

      // V1.5 (Sprint H3) — reconcile observed fix interval. Compare deltaT entre
      // deviceTime de cette trame et lastValidFrameAt pour detecter si le boitier
      // honore l'intervalle desire (ou si on doit incrementer le compteur d'echec).
      const reconciled = this.fixMode.reconcile(tracker, {
        deviceTime: frame.deviceTime,
        speedKmh: frame.speedKph,
        ignition: resolvedIgnition,
        lat: frame.latitude,
        lng: frame.longitude,
      });
      trackerUpdate.currentFixIntervalS = reconciled.nextCurrentFixIntervalS;
      trackerUpdate.fixCommandFailureCount = reconciled.nextFailureCount;
      trackerUpdate.fixCommandFailing = reconciled.nextFailing;
      trackerUpdate.lastValidFrameAt = frame.deviceTime;
    }

    const wasOffline = tracker.status !== 'ONLINE';
    await this.prisma.tracker.update({
      where: { id: tracker.id },
      data: trackerUpdate,
    });

    // Persist sampling decision (fire-and-forget — audit non critique).
    if (samplingOutcome) {
      this.sampling
        .recordDecision(tracker.id, samplingOutcome, frame.speedKph, resolvedIgnition)
        .catch(() => {
          /* swallowed in service */
        });
    }

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

    // V1.5 (Sprint H3) — pilotage fix mode boitier. Sur transition d'etat, on
    // demande au boitier d'ajuster son intervalle d'envoi via la commande
    // Coban `fix...***n`. Fire-and-forget : l'echec n'impacte pas l'ingestion.
    if (samplingState && tracker.vehicle?.fleet) {
      const stateChanged = tracker.lastSampledState !== samplingState;
      const desiredS = this.fixMode.desiredIntervalFor(samplingState, tracker);
      if (stateChanged || desiredS !== tracker.desiredFixIntervalS) {
        this.fixMode
          .requestChange(
            tracker as Tracker & { vehicle: Vehicle & { fleet: NonNullable<typeof tracker.vehicle>['fleet'] } },
            desiredS,
            stateChanged ? `${tracker.lastSampledState ?? 'NEW'}_TO_${samplingState}` : 'STOPPED_GRACE_ELAPSED',
            {
              vehicleId: tracker.vehicle.id,
              fleetId: tracker.vehicle.fleetId,
              plate: tracker.vehicle.plate,
              speedKmh: frame.speedKph,
              ignition: resolvedIgnition ?? null,
              latitude: frame.latitude,
              longitude: frame.longitude,
              previousState: tracker.lastSampledState,
              newState: samplingState,
              lastSeenAt: tracker.lastSeenAt?.toISOString() ?? null,
              lastIgnitionChangeAt: tracker.lastIgnitionChangeAt?.toISOString() ?? null,
            },
          )
          .catch((err) => {
            this.logger.warn(
              `Fix mode requestChange failed for ${tracker.imei}: ${err instanceof Error ? err.message : err}`,
            );
          });
      }
    }

    // V1.5 (Sprint H1) — persistance Position conditionnee par le sampling.
    // Quand `shouldInsert = false`, on conserve uniquement la denormalisation
    // sur Tracker (deja faite plus haut) et l'audit dans `position_sampling_decisions`.
    if (samplingOutcome?.shouldInsert) {
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
    }

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
      // Broadcast WS systematique (UX-first), independant du sampling DB.
      // V1.5 (Sprint H1) — coalescing 1s : on enqueue dans le buffer plutot
      // que d'emit immediatement. Si le buffer est desactive (env var), il
      // retourne false et on fallback sur l'emit immediat legacy.
      const buffered = this.broadcastBuffer.enqueue(tracker.vehicle.fleetId, event);
      if (!buffered) {
        this.gateway.broadcastPosition(tracker.vehicle.fleetId, event);
      }

      this.geofences.checkViolations(
        tracker.id, frame.latitude, frame.longitude,
        tracker.vehicle.fleetId, tracker.vehicle.id, tracker.imei,
      ).catch((err) => {
        this.logger.error('Geofence check failed', err);
        this.errorLogger.record(err instanceof Error ? err : new Error(String(err)), 'geofences', { imei: frame.imei, trackerId: tracker.id }).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
      });

      // Trip processing only on actually persisted positions — sinon on
      // dupliquerait la segmentation sur des trames quasi identiques.
      if (samplingOutcome?.shouldInsert) {
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
