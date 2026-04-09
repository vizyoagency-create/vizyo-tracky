import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { AlertDto, PositionUpdateDto, TrackerStatusChangedDto } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200', credentials: true },
  namespace: '/realtime',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('fleet:subscribe')
  onSubscribe(@MessageBody() fleetId: string, @ConnectedSocket() client: Socket): void {
    client.join(`fleet:${fleetId}`);
  }

  @SubscribeMessage('fleet:unsubscribe')
  onUnsubscribe(@MessageBody() fleetId: string, @ConnectedSocket() client: Socket): void {
    client.leave(`fleet:${fleetId}`);
  }

  emitPosition(fleetId: string, payload: PositionUpdateDto): void {
    this.server.to(`fleet:${fleetId}`).emit(WS_EVENTS.POSITION_UPDATE, payload);
  }

  emitTrackerStatus(fleetId: string, payload: TrackerStatusChangedDto): void {
    this.server.to(`fleet:${fleetId}`).emit(WS_EVENTS.TRACKER_STATUS, payload);
  }

  emitAlert(fleetId: string, payload: AlertDto): void {
    this.server.to(`fleet:${fleetId}`).emit(WS_EVENTS.ALERT_NEW, payload);
  }
}
