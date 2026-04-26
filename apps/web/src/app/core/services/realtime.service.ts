import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { AlertAcknowledgedEvent, AlertEvent, EngineCommandUpdatedEvent, PositionUpdateEvent, TrackerStatusChangedDto } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PreferencesService } from './preferences.service';

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  readonly positions = signal<Map<string, PositionUpdateEvent>>(new Map());
  readonly connected = signal(false);
  readonly positionsList = computed(() => Array.from(this.positions().values()));

  private readonly _alerts = signal<AlertEvent[]>([]);
  readonly alerts = this._alerts.asReadonly();
  readonly unacknowledgedCount = computed(() => this._alerts().length);
  readonly hasCritical = computed(() => this._alerts().some((a) => a.severity === 'CRITICAL'));

  private readonly _trackerStatuses = signal<Map<string, string>>(new Map());
  readonly trackerStatuses = this._trackerStatuses.asReadonly();

  private readonly _engineCommandUpdates = signal<Map<string, EngineCommandUpdatedEvent>>(new Map());
  readonly engineCommandUpdates = this._engineCommandUpdates.asReadonly();

  private socket: Socket | null = null;
  private readonly toast = inject(ToastService);
  private readonly preferences = inject(PreferencesService);
  private readonly http = inject(HttpClient);

  connect(token: string): void {
    if (this.socket?.connected) return;

    this.socket = io('/realtime', {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
    });

    this.socket.on('connect', () => {
      this.connected.set(true);
      this.loadInitialAlerts();
    });

    this.socket.on('disconnect', () => {
      this.connected.set(false);
    });

    this.socket.on(WS_EVENTS.POSITION_UPDATE, (event: PositionUpdateEvent) => {
      const next = new Map(this.positions());
      next.set(event.trackerId, event);
      this.positions.set(next);
    });

    this.socket.on(WS_EVENTS.ALERT_NEW, (alert: AlertEvent) => {
      this._alerts.update((list) => [alert, ...list]);
      // Respecter les préférences de notification
      const notifPrefs = this.preferences.prefs().notifications;
      const sevKey = alert.severity === 'CRITICAL' ? 'critical' : alert.severity === 'WARNING' ? 'warning' : 'info';
      const pref = notifPrefs[sevKey];
      if (pref.enabled) {
        this.toast.show({
          kind: alert.severity === 'CRITICAL' ? 'error' : alert.severity === 'WARNING' ? 'warning' : 'info',
          title: alert.title,
          message: alert.vehiclePlate ? `Véhicule ${alert.vehiclePlate}` : undefined,
          duration: pref.duration,
        });
      }
    });

    this.socket.on(WS_EVENTS.ALERT_ACK, (event: AlertAcknowledgedEvent) => {
      this._alerts.update((list) => list.filter((a) => a.id !== event.id));
    });

    this.socket.on(WS_EVENTS.TRACKER_STATUS, (event: TrackerStatusChangedDto) => {
      const next = new Map(this._trackerStatuses());
      next.set(event.trackerId, event.status);
      this._trackerStatuses.set(next);
    });

    this.socket.on(WS_EVENTS.ENGINE_COMMAND_UPDATED, (event: EngineCommandUpdatedEvent) => {
      const next = new Map(this._engineCommandUpdates());
      next.set(event.trackerId, event);
      this._engineCommandUpdates.set(next);
    });
  }

  dismissAlert(id: string): void {
    this._alerts.update((list) => list.filter((a) => a.id !== id));
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.connected.set(false);
    this.positions.set(new Map());
    this._alerts.set([]);
    this._trackerStatuses.set(new Map());
    this._engineCommandUpdates.set(new Map());
  }

  private async loadInitialAlerts(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ items: AlertEvent[] }>('/api/alerts', {
          params: { acknowledged: 'false', limit: '50' },
        }),
      );
      this._alerts.set(res.items ?? []);
    } catch {
      // Silent — alerts will come via WS
    }
  }
}
