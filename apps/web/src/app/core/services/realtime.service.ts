import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { AlertAcknowledgedEvent, AlertEvent, FleetSnapshotResponse, PositionUpdateEvent, TrackerStatusChangedDto, VehicleSnapshotDto } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PreferencesService } from './preferences.service';

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  readonly positions = signal<Map<string, PositionUpdateEvent>>(new Map());
  readonly connected = signal(false);
  readonly hydrated = signal(false);
  readonly positionsList = computed(() => Array.from(this.positions().values()));

  /**
   * Indique si une position donnee provient d'une hydratation REST (vs un live WS).
   * Utile pour afficher une pastille "il y a X min" et eviter d'animer au premier rendu.
   */
  readonly hydratedTrackerIds = signal<Set<string>>(new Set());

  /**
   * Snapshot complet recu du backend : metadonnees + derniere position connue.
   * Conserve pour permettre aux composants (MapComponent) de connaitre type/plate
   * sans appel supplementaire a /api/vehicles.
   */
  readonly snapshot = signal<VehicleSnapshotDto[]>([]);

  private readonly _alerts = signal<AlertEvent[]>([]);
  readonly alerts = this._alerts.asReadonly();
  readonly unacknowledgedCount = computed(() => this._alerts().length);
  readonly hasCritical = computed(() => this._alerts().some((a) => a.severity === 'CRITICAL'));

  private readonly _trackerStatuses = signal<Map<string, string>>(new Map());
  readonly trackerStatuses = this._trackerStatuses.asReadonly();

  private socket: Socket | null = null;
  private readonly toast = inject(ToastService);
  private readonly preferences = inject(PreferencesService);
  private readonly http = inject(HttpClient);

  connect(token: string): void {
    if (this.socket?.connected) return;

    // Hydratation immediate en parallele de la connexion WS — la carte ne reste plus
    // vide en attendant la prochaine trame Coban.
    this.hydrate().catch(() => { /* silent: live WS will populate eventually */ });

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

      // Une fois qu'un vrai live event arrive, on retire le flag d'hydratation.
      const hydratedIds = this.hydratedTrackerIds();
      if (hydratedIds.has(event.trackerId)) {
        const newSet = new Set(hydratedIds);
        newSet.delete(event.trackerId);
        this.hydratedTrackerIds.set(newSet);
      }
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
          message: alert.vehiclePlate ? `Vehicule ${alert.vehiclePlate}` : undefined,
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
  }

  dismissAlert(id: string): void {
    this._alerts.update((list) => list.filter((a) => a.id !== id));
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.connected.set(false);
    this.hydrated.set(false);
    this.positions.set(new Map());
    this.snapshot.set([]);
    this.hydratedTrackerIds.set(new Set());
    this._alerts.set([]);
    this._trackerStatuses.set(new Map());
  }

  /**
   * Hydratation immediate de la carte au login : recupere la derniere position
   * connue de chaque vehicule via /api/vehicles/snapshot et peuple le signal
   * `positions` sans attendre la prochaine trame WS.
   *
   * Les events `POSITION_UPDATE` qui arrivent ensuite ecrasent naturellement
   * les valeurs hydratees (meme cle = trackerId).
   */
  private async hydrate(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<FleetSnapshotResponse>('/api/vehicles/snapshot'),
      );
      const items = res.items ?? [];
      this.snapshot.set(items);

      const next = new Map(this.positions());
      const hydratedIds = new Set<string>();

      for (const v of items) {
        if (
          !v.trackerId ||
          v.lastLat == null || v.lastLng == null ||
          v.lastPositionAt == null
        ) {
          continue;
        }

        // Si une position WS est deja arrivee pour ce tracker pendant l'hydratation,
        // ne pas l'ecraser (le live est plus frais).
        if (next.has(v.trackerId)) continue;

        next.set(v.trackerId, {
          trackerId: v.trackerId,
          vehicleId: v.vehicleId,
          fleetId: v.fleetId,
          lat: v.lastLat,
          lng: v.lastLng,
          speedKmh: v.lastSpeedKmh ?? 0,
          heading: v.lastHeading ?? 0,
          timestamp: v.lastPositionAt,
          ignition: v.lastIgnition ?? false,
          valid: v.lastValid ?? true,
        });
        hydratedIds.add(v.trackerId);
      }

      this.positions.set(next);
      this.hydratedTrackerIds.set(hydratedIds);
      this.hydrated.set(true);
    } catch {
      // Silent — la carte se peuplera via WS.
    }
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
