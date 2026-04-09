import { computed, Injectable, signal } from '@angular/core';
import type { PositionUpdateEvent } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import { io, Socket } from 'socket.io-client';

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  readonly positions = signal<Map<string, PositionUpdateEvent>>(new Map());
  readonly connected = signal(false);
  readonly positionsList = computed(() => Array.from(this.positions().values()));

  private socket: Socket | null = null;

  connect(token: string): void {
    if (this.socket?.connected) return;

    this.socket = io('/realtime', {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
    });

    this.socket.on('connect', () => {
      this.connected.set(true);
    });

    this.socket.on('disconnect', () => {
      this.connected.set(false);
    });

    this.socket.on(WS_EVENTS.POSITION_UPDATE, (event: PositionUpdateEvent) => {
      const next = new Map(this.positions());
      next.set(event.trackerId, event);
      this.positions.set(next);
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.connected.set(false);
    this.positions.set(new Map());
  }
}
