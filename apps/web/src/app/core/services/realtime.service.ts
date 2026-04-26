import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { AlertAcknowledgedEvent, AlertEvent, EngineCommandUpdatedEvent, FleetSnapshotResponse, PositionUpdateEvent, TrackerStatusChangedDto, VehicleSnapshotDto } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PreferencesService } from './preferences.service';

/**
 * Apres BACKGROUND_SLEEP_MS en arriere-plan, on coupe le WS pour eviter
 * que socket.io tente de reconnecter en boucle pendant que l'onglet est
 * suspendu (iOS Safari coupe deja les WS en background apres ~30s).
 */
const BACKGROUND_SLEEP_MS = 30_000;

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

  private readonly _engineCommandUpdates = signal<Map<string, EngineCommandUpdatedEvent>>(new Map());
  readonly engineCommandUpdates = this._engineCommandUpdates.asReadonly();

  private socket: Socket | null = null;
  private currentToken: string | null = null;
  private readonly toast = inject(ToastService);
  private readonly preferences = inject(PreferencesService);
  private readonly http = inject(HttpClient);

  // Coalescing : on accumule les position updates et on flush via requestAnimationFrame.
  // 100 vehicules x 1 trame/s = 1 setSignal/frame au lieu de 100, sans perte d'info.
  private readonly positionBuffer = new Map<string, PositionUpdateEvent>();
  private flushScheduled = false;

  // Listeners visibility / online (gardes en propriete pour pouvoir les retirer)
  private readonly visibilityHandler = () => {
    if (typeof document === 'undefined') return;
    if (document.hidden) this.onBackground();
    else this.onForeground();
  };
  private readonly onlineHandler = () => this.onForeground();
  private readonly offlineHandler = () => { /* on laisse le WS tomber tout seul, la banniere reseau fait le reste */ };
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private listenersAttached = false;

  connect(token: string): void {
    if (this.socket?.connected) return;
    this.currentToken = token;

    // Hydratation immediate en parallele de la connexion WS — la carte ne reste plus
    // vide en attendant la prochaine trame Coban.
    this.hydrate().catch(() => { /* silent: live WS will populate eventually */ });

    this.attachLifecycleListeners();

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
      // Coalescing : buffer + flush au prochain frame paint.
      // Evite N appels signal.set quand N trames arrivent dans la meme frame (commun avec 100+ vehicules).
      this.bufferPosition(event);
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
    this.detachLifecycleListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.currentToken = null;
    this.connected.set(false);
    this.hydrated.set(false);
    this.positions.set(new Map());
    this.snapshot.set([]);
    this.hydratedTrackerIds.set(new Set());
    this._alerts.set([]);
    this._trackerStatuses.set(new Map());
    this._engineCommandUpdates.set(new Map());
    this.positionBuffer.clear();
    this.flushScheduled = false;
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Coalescing positions via requestAnimationFrame
  // ---------------------------------------------------------------------

  private bufferPosition(event: PositionUpdateEvent): void {
    this.positionBuffer.set(event.trackerId, event);
    if (this.flushScheduled) return;
    this.flushScheduled = true;

    // requestAnimationFrame : flush a la prochaine frame de rendu (~16ms).
    // En arriere-plan le browser throttle rAF a ~1Hz, ce qui amortit naturellement
    // les setSignal pendant que l'utilisateur n'est pas sur l'onglet.
    const raf = typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16);
    raf(() => this.flushPositions());
  }

  private flushPositions(): void {
    this.flushScheduled = false;
    if (this.positionBuffer.size === 0) return;

    const next = new Map(this.positions());
    const hydratedIds = this.hydratedTrackerIds();
    let hydratedDirty = false;
    let newHydrated: Set<string> | null = null;

    for (const [trackerId, event] of this.positionBuffer) {
      next.set(trackerId, event);
      // Un live event efface le flag "hydrate via REST" -> le marker passe a opacite 1.
      if (hydratedIds.has(trackerId)) {
        if (!newHydrated) newHydrated = new Set(hydratedIds);
        newHydrated.delete(trackerId);
        hydratedDirty = true;
      }
    }

    this.positionBuffer.clear();
    this.positions.set(next);
    if (hydratedDirty && newHydrated) this.hydratedTrackerIds.set(newHydrated);
  }

  // ---------------------------------------------------------------------
  // Lifecycle : visibility + online/offline
  // ---------------------------------------------------------------------

  private attachLifecycleListeners(): void {
    if (this.listenersAttached || typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this.visibilityHandler);
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.listenersAttached = true;
  }

  private detachLifecycleListeners(): void {
    if (!this.listenersAttached || typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.listenersAttached = false;
  }

  /**
   * App passe en arriere-plan : on attend BACKGROUND_SLEEP_MS puis on coupe le WS.
   * On marque aussi le body avec `app-paused` pour que les animations CSS
   * (pulse markers, spinners) se mettent en pause.
   */
  private onBackground(): void {
    if (typeof document !== 'undefined') document.body.classList.add('app-paused');
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = setTimeout(() => {
      // Apres 30s sans focus : on ferme le WS proprement.
      // Au retour de focus, onForeground() rouvre + re-hydrate via REST.
      this.socket?.disconnect();
    }, BACKGROUND_SLEEP_MS);
  }

  /**
   * App revient au premier plan ou reseau revient :
   * - reactive le WS si necessaire (avec le token courant),
   * - re-hydrate via REST pour rafraichir les snapshots.
   */
  private onForeground(): void {
    if (typeof document !== 'undefined') document.body.classList.remove('app-paused');
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
    }

    // Re-hydrate (best-effort) : ramene un snapshot frais meme si le WS rate son reconnect.
    this.hydrate().catch(() => { /* silent */ });

    if (this.currentToken && (!this.socket?.connected)) {
      // Si le socket existe encore mais est deconnecte -> connect()
      // Sinon (timeout l'a kill) -> recreate avec le token courant
      if (this.socket) {
        this.socket.connect();
      } else {
        this.connect(this.currentToken);
      }
    }
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
