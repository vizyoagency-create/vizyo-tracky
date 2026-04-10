import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { AlertEvent, GeofenceViolationEvent, PositionUpdateEvent, TrackerStatusChangedDto } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import type { Alert, Vehicle, Tracker } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200', credentials: true },
  namespace: '/realtime',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly auth: AuthService) {}

  handleConnection(client: Socket): void {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      if (!token) {
        this.logger.warn(`Client ${client.id} rejected: no token`);
        client.disconnect();
        return;
      }

      const payload = this.auth.verify(token);
      const fleetId = payload.fleetId;
      const role = payload.role;

      if (role === 'SUPER_ADMIN') {
        client.join('fleet:*');
      }

      if (fleetId) {
        client.join(`fleet:${fleetId}`);
      }

      this.logger.debug(`Client ${client.id} authenticated (${payload.email}, fleet=${fleetId})`);
    } catch {
      this.logger.warn(`Client ${client.id} rejected: invalid token`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

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
}
