import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { AlertEvent, EngineCommandUpdatedEvent, GeofenceViolationEvent, PositionUpdateEvent, TrackerStatusChangedDto, TripStartedEvent, TripCompletedEvent } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import type { Alert, Vehicle, Tracker } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200', credentials: true },
  namespace: '/realtime',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);

  // V1.10 (Sprint 6) — clients Redis pour le pub/sub adapter Socket.io.
  // Stockes en propriete pour pouvoir les quit() au shutdown propre.
  private redisPub: { quit: () => Promise<unknown> } | null = null;
  private redisSub: { quit: () => Promise<unknown> } | null = null;

  @WebSocketServer()
  server!: Server;

  constructor(private readonly auth: AuthService) {}

  /**
   * V1.10 (Sprint 6) — branche l'adapter Redis sur le Socket.io server si
   * REDIS_URL est defini. Sans Redis (mode dev / single-instance prod), le
   * memory adapter par defaut reste actif — comportement inchange.
   *
   * Avec Redis, plusieurs instances API partagent leurs broadcasts WS via
   * pub/sub. Permet de scale horizontalement derriere un load balancer sans
   * que les events restent confines a l'instance qui les a recus.
   *
   * Best effort : si le require @socket.io/redis-adapter ou la connexion
   * Redis echoue, on log et on continue en memoire (degradation gracieuse,
   * pas de crash boot).
   */
  async afterInit(server: Server): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      this.logger.log('[ws-adapter] REDIS_URL absent — memory adapter (single instance)');
      return;
    }
    try {
      // Dynamic require pour ne pas crash si la dep n'est pas installee (CI minimal,
      // dev sans Redis). En prod, package.json l'a en dependances directes.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createAdapter } = require('@socket.io/redis-adapter') as typeof import('@socket.io/redis-adapter');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Redis = require('ioredis').default ?? require('ioredis');

      this.redisPub = new Redis(redisUrl);
      this.redisSub = ((this.redisPub as unknown) as { duplicate: () => unknown }).duplicate() as { quit: () => Promise<unknown> };
      server.adapter(createAdapter(this.redisPub as any, this.redisSub as any));
      this.logger.log(`[ws-adapter] Redis adapter active (multi-instance ready)`);
    } catch (err) {
      this.logger.warn(
        `[ws-adapter] Redis adapter init failed, falling back to memory: ${err instanceof Error ? err.message : err}`,
      );
      this.redisPub = null;
      this.redisSub = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      this.redisPub?.quit().catch(() => undefined),
      this.redisSub?.quit().catch(() => undefined),
    ]);
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) {
        this.logger.warn(`Client ${client.id} rejected: no token`);
        client.disconnect();
        return;
      }

      const payload = this.auth.verifyAccessToken(token);
      const localUser = await this.auth.resolveLocalUser(payload.sub);

      if (localUser.role === 'SUPER_ADMIN') {
        client.join('fleet:*');
      }

      if (localUser.fleetId) {
        client.join(`fleet:${localUser.fleetId}`);
      }

      this.logger.debug(`Client ${client.id} authenticated (${localUser.email}, fleet=${localUser.fleetId})`);
    } catch (err) {
      this.logger.warn(`Client ${client.id} rejected: ${err instanceof Error ? err.message : 'invalid token'}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * Emit a single POSITION_UPDATE immediately (legacy path).
   *
   * Most callers should go through `PositionBroadcastBuffer.enqueue()` which
   * coalesces 1s windows into POSITIONS_BATCH events. The immediate path is
   * kept for explicit cases (alerts, geofence violations linked to a position).
   */
  broadcastPosition(fleetId: string, payload: PositionUpdateEvent): void {
    this.server.to(`fleet:${fleetId}`).to('fleet:*').emit(WS_EVENTS.POSITION_UPDATE, payload);
  }

  emitTrackerStatus(fleetId: string, payload: TrackerStatusChangedDto): void {
    this.server.to(`fleet:${fleetId}`).to('fleet:*').emit(WS_EVENTS.TRACKER_STATUS, payload);
  }

  broadcastAlert(alert: Alert & { vehicle?: Vehicle | null; tracker?: Tracker | null }): void {
    const event: AlertEvent = {
      id: alert.id,
      fleetId: alert.fleetId,
      vehicleId: alert.vehicleId,
      trackerId: alert.trackerId,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      latitude: alert.latitude,
      longitude: alert.longitude,
      createdAt: alert.createdAt.toISOString(),
      vehiclePlate: (alert as any).vehicle?.plate,
    };
    this.server.to(`fleet:${alert.fleetId}`).to('fleet:*').emit(WS_EVENTS.ALERT_NEW, event);
  }

  broadcastAlertAcknowledged(alert: Alert): void {
    this.server
      .to(`fleet:${alert.fleetId}`)
      .to('fleet:*')
      .emit(WS_EVENTS.ALERT_ACK, {
        id: alert.id,
        acknowledgedAt: alert.acknowledgedAt?.toISOString(),
        acknowledgedBy: alert.acknowledgedBy,
      });
  }

  broadcastGeofenceViolation(fleetId: string, event: GeofenceViolationEvent): void {
    this.server.to(`fleet:${fleetId}`).to('fleet:*').emit(WS_EVENTS.GEOFENCE_VIOLATION, event);
  }

  emitTripStarted(fleetId: string, event: TripStartedEvent): void {
    this.server.to(`fleet:${fleetId}`).to('fleet:*').emit(WS_EVENTS.TRIP_STARTED, event);
  }

  emitTripCompleted(fleetId: string, event: TripCompletedEvent): void {
    this.server.to(`fleet:${fleetId}`).to('fleet:*').emit(WS_EVENTS.TRIP_COMPLETED, event);
  }

  emitEngineCommandUpdate(fleetId: string, payload: EngineCommandUpdatedEvent): void {
    this.server.to(`fleet:${fleetId}`).to('fleet:*').emit(WS_EVENTS.ENGINE_COMMAND_UPDATED, payload);
  }
}
