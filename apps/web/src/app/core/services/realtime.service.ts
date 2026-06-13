import { HttpClient } from '@angular/common/http';
import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { AlertAcknowledgedEvent, AlertEvent, EngineCommandUpdatedEvent, FleetSnapshotResponse, PositionsBatchEvent, PositionUpdateEvent, TrackerStatusChangedDto, VehicleSnapshotDto } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { AuthService } from './auth.service';
import { NotificationsApiService } from './notifications.service';
import { PreferencesService } from './preferences.service';
import { VisibilityService } from './visibility.service';

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

  /** Etat persistant : quels trackers ont un CUT actif. Hydrate au login, mis a jour par WS. */
  private readonly _cutActiveTrackerIds = signal<Set<string>>(new Set());
  readonly cutActiveTrackerIds = this._cutActiveTrackerIds.asReadonly();

  private socket: Socket | null = null;
  private refreshingToken = false;
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);
  private readonly preferences = inject(PreferencesService);
  private readonly http = inject(HttpClient);
  private readonly visibility = inject(VisibilityService);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationsApiService);

  /**
   * V1.5 (Sprint H2) — re-hydratation au retour foreground apres > 60s d'absence.
   * On maintient la connexion WS dans tous les cas (decision UX), mais quand un
   * onglet a ete cache longtemps, on rafraichit l'etat carte via le snapshot
   * REST plutot que d'attendre que les positions convergent via WS.
   *
   * On en profite aussi pour piloter la classe CSS `app-paused` sur <body>
   * (cf. styles.css) qui pause les animate-pulse / pulse markers en background.
   */
  private readonly visibilityEffect = effect(() => {
    const visible = this.visibility.isVisible();
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('app-paused', !visible);
    }
    if (!visible) return;
    // L'utilisateur revient sur l'app -> on clear le badge sur l'icone (le "1" que
    // les notifs avaient affiche). Pattern Slack/Linear : badge = notifs en attente,
    // tu reviens, c'est lu, badge a 0.
    this.notifications.clearAppBadge();
    const hiddenMs = this.visibility.lastHiddenDurationMs();
    // Au retour apres > 60s, rafraichir le token du socket et re-hydrater.
    if (hiddenMs !== null && hiddenMs > 60 * 1000) {
      this.auth.tryRefresh().then((newToken) => {
        if (newToken && this.socket) {
          (this.socket.auth as Record<string, string>)['token'] = newToken;
          if (!this.socket.connected) this.socket.connect();
        }
      }).catch(() => { /* silent */ });
      this.hydrate().catch(() => { /* silent */ });
    }
  });

  // Coalescing : on accumule les position updates et on flush via requestAnimationFrame.
  // 100 vehicules x 1 trame/s = 1 setSignal/frame au lieu de 100, sans perte d'info.
  // En arriere-plan, le browser throttle rAF a ~1Hz : amortissement naturel.
  private readonly positionBuffer = new Map<string, PositionUpdateEvent>();
  private flushScheduled = false;

  /**
   * Toast throttling : memorise le timestamp du dernier toast affiche par couple
   * (vehicleId, alertType). Un toast identique dans les 60s suivantes est skip
   * (l'alerte est toujours pushee dans le signal `_alerts` et apparait dans la
   * liste /alerts + cloche, juste pas de toast supplementaire). Evite le spam
   * en mock dev (alarmes generees toutes les 2s) et en prod sur des situations
   * persistantes (overspeed continu sur autoroute, mouvement detecte a l'arret
   * apres incident...).
   */
  private readonly lastToastByKey = new Map<string, number>();
  private static readonly TOAST_THROTTLE_MS = 60_000;
  private shouldThrottleToast(alert: AlertEvent): boolean {
    const key = `${alert.vehicleId ?? 'fleet'}:${alert.type}`;
    const now = Date.now();
    const last = this.lastToastByKey.get(key) ?? 0;
    if (now - last < RealtimeService.TOAST_THROTTLE_MS) return true;
    this.lastToastByKey.set(key, now);
    // Garbage collect : si la map grossit > 100 entrees, droppe les plus vieilles.
    if (this.lastToastByKey.size > 100) {
      const cutoff = now - RealtimeService.TOAST_THROTTLE_MS;
      for (const [k, t] of this.lastToastByKey) {
        if (t < cutoff) this.lastToastByKey.delete(k);
      }
    }
    return false;
  }

  connect(token: string): void {
    if (this.socket?.connected) return;

    // Hydratation immediate en parallele de la connexion WS — la carte ne reste plus
    // vide en attendant la prochaine trame Coban.
    this.hydrate().catch(() => { /* silent: live WS will populate eventually */ });

    // Transport : on tente WebSocket d'abord (connexion rapide), MAIS avec repli
    // polling si l'upgrade WS echoue. Sans `tryAllTransports`, socket.io-client
    // >=4.8 (defaut false) ne tente JAMAIS le transport suivant : un upgrade WS
    // qui echoue (proxy capricieux, redemarrage API sous CPU sature) coupe le
    // live en TOTALITE au lieu de degrader en polling. Cf. Sprint 0.1 DIAGNOSTIC.
    this.socket = io('/realtime', {
      auth: { token },
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      reconnection: true,
    });

    this.socket.on('connect', () => {
      this.connected.set(true);
      this.loadInitialAlerts();
    });

    this.socket.on('disconnect', () => {
      this.connected.set(false);
    });

    // Token expire → socket.io reconnecte avec l'ancien token → rejet backend.
    // On refresh le JWT et on met a jour le handshake auth pour la prochaine tentative.
    this.socket.on('connect_error', async () => {
      if (this.refreshingToken || !this.socket) return;
      this.refreshingToken = true;
      try {
        const newToken = await this.auth.tryRefresh();
        if (newToken && this.socket) {
          (this.socket.auth as Record<string, string>)['token'] = newToken;
        }
      } finally {
        this.refreshingToken = false;
      }
    });

    this.socket.on(WS_EVENTS.POSITION_UPDATE, (event: PositionUpdateEvent) => {
      // Coalescing : buffer + flush au prochain frame paint.
      // Evite N appels signal.set quand N trames arrivent dans la meme frame (commun avec 100+ vehicules).
      this.bufferPosition(event);
    });

    // V1.5 (Sprint H1) — batch coalescing serveur. Chaque position est routee dans
    // le buffer rAF pour consolider toutes les ecritures en un seul setSignal au paint.
    this.socket.on(WS_EVENTS.POSITIONS_BATCH, (event: PositionsBatchEvent) => {
      if (!event.positions || event.positions.length === 0) return;
      for (const pos of event.positions) this.bufferPosition(pos);
    });

    this.socket.on(WS_EVENTS.ALERT_NEW, (alert: AlertEvent) => {
      this._alerts.update((list) => [alert, ...list]);
      // Respecter les préférences de notification
      const notifPrefs = this.preferences.prefs().notifications;
      const sevKey = alert.severity === 'CRITICAL' ? 'critical' : alert.severity === 'WARNING' ? 'warning' : 'info';
      const pref = notifPrefs[sevKey];
      if (!pref.enabled || this.shouldThrottleToast(alert)) return;

      // V1.8 (web-push-finalize) — pour les CRITICAL, on declenche le toast
      // riche (son + vibration + actions Acquitter/Voir + style pulsant). Le SW
      // affiche en parallele une notif systeme si l'app est background ; en
      // foreground certains browsers la suppriment, donc le toast in-app est
      // notre garantie d'un signal visible+audible cote utilisateur.
      if (alert.severity === 'CRITICAL') {
        this.toast.critical({
          title: alert.title,
          message: alert.vehiclePlate ? `Vehicule ${alert.vehiclePlate}` : undefined,
          onAcknowledge: () => this.acknowledgeAlertInline(alert.id),
          onView: () => { void this.router.navigateByUrl('/alerts'); },
        });
        return;
      }

      this.toast.show({
        kind: alert.severity === 'WARNING' ? 'warning' : 'info',
        title: alert.title,
        message: alert.vehiclePlate ? `Véhicule ${alert.vehiclePlate}` : undefined,
        duration: pref.duration,
      });
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

      // Maintenir l'etat persistant CUT actif
      const effective = event.status === 'SENT' || event.status === 'ACKNOWLEDGED';
      const ids = new Set(this._cutActiveTrackerIds());
      if (event.action === 'CUT' && effective) {
        ids.add(event.trackerId);
      } else if (event.action === 'RESTORE' && effective) {
        ids.delete(event.trackerId);
      }
      this._cutActiveTrackerIds.set(ids);
    });
  }

  dismissAlert(id: string): void {
    this._alerts.update((list) => list.filter((a) => a.id !== id));
  }

  /**
   * Acquittement depuis un toast critical (in-app). Le serveur emettra
   * ALERT_ACK qui retire l'alerte de la liste — pas besoin d'updater le
   * signal ici. Erreurs silencieuses (toast d'erreur deja affiche par
   * l'appelant si besoin).
   */
  private acknowledgeAlertInline(alertId: string): void {
    void firstValueFrom(this.http.post(`/api/alerts/${alertId}/acknowledge`, {})).catch(() => {
      this.toast.error('Echec de l\'acquittement', 'Reessayer depuis la liste des alertes');
    });
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
    this._engineCommandUpdates.set(new Map());
    this._cutActiveTrackerIds.set(new Set());
    this.positionBuffer.clear();
    this.flushScheduled = false;
    this.lastToastByKey.clear();
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

    // Auto-cleanup : si une position confirme l'etat d'une commande moteur,
    // supprimer l'entree pour eviter un patch stale dans le futur.
    const engineCmds = this._engineCommandUpdates();
    let engineDirty = false;
    let newEngineCmds: Map<string, EngineCommandUpdatedEvent> | null = null;

    for (const [trackerId, event] of this.positionBuffer) {
      next.set(trackerId, event);
      // Un live event efface le flag "hydrate via REST" -> le marker passe a opacite 1.
      if (hydratedIds.has(trackerId)) {
        if (!newHydrated) newHydrated = new Set(hydratedIds);
        newHydrated.delete(trackerId);
        hydratedDirty = true;
      }
      // Cleanup engine command si la position confirme l'etat attendu.
      const cmd = engineCmds.get(trackerId);
      if (cmd) {
        const confirmed =
          (cmd.action === 'CUT' && !event.ignition) ||
          (cmd.action === 'RESTORE' && event.ignition);
        if (confirmed) {
          if (!newEngineCmds) newEngineCmds = new Map(engineCmds);
          newEngineCmds.delete(trackerId);
          engineDirty = true;
        }
      }
    }

    this.positionBuffer.clear();
    this.positions.set(next);
    if (hydratedDirty && newHydrated) this.hydratedTrackerIds.set(newHydrated);
    if (engineDirty && newEngineCmds) this._engineCommandUpdates.set(newEngineCmds);
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

      // Hydrater l'etat CUT actif depuis le snapshot
      const cutIds = new Set<string>();
      for (const v of items) {
        if (v.trackerId && v.engineCutActive) cutIds.add(v.trackerId);
      }
      this._cutActiveTrackerIds.set(cutIds);

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
