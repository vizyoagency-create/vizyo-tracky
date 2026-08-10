import { swallow } from '../../core/error/swallow';
import { HttpClient } from '@angular/common/http';
import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { AlertAcknowledgedEvent, AlertEvent, EngineCommandUpdatedEvent, FleetSnapshotResponse, PositionsBatchEvent, PositionUpdateEvent, TrackerStatusChangedDto, VehicleMovementEvent, VehicleSnapshotDto } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { AuthService } from './auth.service';
import { FleetFilterService } from './fleet-filter.service';
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

  /**
   * Filtre SOCIÉTÉ global appliqué À LA SOURCE du temps réel : tout consommateur (carte,
   * dashboard, futures vues live) utilise ces signaux déjà scopés → plus de filtre à
   * répéter par composant. `matches()` = no-op pour un non-super ou sans société choisie.
   */
  private readonly fleetFilter = inject(FleetFilterService);
  readonly scopedSnapshot = computed(() => this.snapshot().filter((v) => this.fleetFilter.matches(v.fleetId)));
  readonly scopedPositionsList = computed(() => this.positionsList().filter((p) => this.fleetFilter.matches(p.fleetId)));
  readonly scopedAlerts = computed(() => this._alerts().filter((a) => this.fleetFilter.matches(a.fleetId)));

  private readonly _trackerStatuses = signal<Map<string, string>>(new Map());
  readonly trackerStatuses = this._trackerStatuses.asReadonly();

  private readonly _engineCommandUpdates = signal<Map<string, EngineCommandUpdatedEvent>>(new Map());
  readonly engineCommandUpdates = this._engineCommandUpdates.asReadonly();

  /** Etat persistant : quels trackers ont un CUT CONFIRME (ACKNOWLEDGED). Hydrate au login, MAJ par WS. */
  private readonly _cutActiveTrackerIds = signal<Set<string>>(new Set());
  readonly cutActiveTrackerIds = this._cutActiveTrackerIds.asReadonly();

  /**
   * Sprint 2 (revue #2) — trackers avec une coupure COMMANDEE mais NON encore
   * confirmee (SENT). Distinct de `cutActiveTrackerIds` (coupure confirmee) : permet
   * un affichage tri-etat (normal / en attente / coupe) sans jamais de faux succes.
   */
  private readonly _cutPendingTrackerIds = signal<Set<string>>(new Set());
  readonly cutPendingTrackerIds = this._cutPendingTrackerIds.asReadonly();

  /**
   * Fix veilleur — trackers actuellement EN MOUVEMENT (ignition ON + vitesse > 5 km/h).
   * Hydraté depuis la liste véhicules REST (`seedMovingState`) puis maintenu à jour par
   * les transitions WS `VEHICLE_MOVEMENT`. Le bouton « Couper » du veilleur se grise pour
   * ces trackers (le serveur reste seul juge de la coupe).
   */
  private readonly _movingTrackerIds = signal<Set<string>>(new Set());
  readonly movingTrackerIds = this._movingTrackerIds.asReadonly();

  private socket: Socket | null = null;
  private refreshingToken = false;
  // #9 — echecs consecutifs de refresh sur connect_error. Au-dela du seuil, la
  // session est consideree expiree (refresh token mort) et on STOPPE la reconnexion
  // au lieu de boucler a l'infini sur connect_error -> POST /auth/refresh.
  private connectErrorRefreshFailures = 0;
  private static readonly MAX_CONNECT_REFRESH_FAILURES = 3;

  // Sprint 0.1 (fix live figé) — reconnexion après une coupure INITIÉE PAR LE SERVEUR
  // (reason='io server disconnect'). socket.io ne se reconnecte PAS tout seul dans ce
  // cas (règle du client), et cette coupure ne passe PAS par `connect_error` (donc le
  // refresh de token n'y court pas). Cause racine observée en prod : une reconnexion
  // socket.io réutilise l'ancien token du handshake ; s'il a expiré, `handleConnection`
  // le rejette via `client.disconnect()` → l'utilisateur reste gelé sans live jusqu'à
  // une action (retour d'onglet) → faux incident « 45s sans live ». On rafraîchit donc
  // le token et on relance manuellement. Compteur = garde anti-boucle si le serveur nous
  // éjecte en boucle (compte suspendu : le handshake rejette même avec un token frais).
  private serverKickReconnects = 0;
  private serverKickTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_SERVER_KICK_RECONNECTS = 5;

  // Sprint 0.1 — surveillance d'interruption du canal temps réel. Si le socket
  // reste coupé au-delà du seuil, on remonte un incident au centre d'alerte
  // (panne grave : plus de vue live). Re-report périodique tant que coupé.
  private disconnectedSince: number | null = null;
  private incidentTimer: ReturnType<typeof setTimeout> | null = null;
  // Instrumentation — pour identifier POURQUOI le live tombe (remonté au centre d'alerte).
  private lastDisconnectReason: string | null = null;
  private lastConnectError: string | null = null;
  private flapCount = 0;
  private everConnected = false;
  private static readonly INCIDENT_DELAY_MS = 45_000;
  // Re-report espacé (1 incident/30min max pour une coupure qui dure) pour ne
  // PAS inonder le centre d'alerte — une coupure de 16 min ne produit qu'1 alerte.
  private static readonly INCIDENT_REPEAT_MS = 30 * 60_000;
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
    if (!visible) {
      // V1.18 — Passage en arrière-plan : désarmer le timer d'incident temps réel.
      // Un socket WS coupé en background est NORMAL (le navigateur throttle/gèle les
      // timers et laisse tomber le ping/pong) ; un timer gelé qui se déclenche au
      // réveil remonterait un downMs gonflé = faux CRITICAL « live interrompu » alors
      // que l'utilisateur ne regardait même pas la carte. On conserve
      // `disconnectedSince` (on sait qu'on est coupé) mais AUCUN timer ne court tant
      // qu'on est caché. La reprise se fait au retour au premier plan (plus bas).
      if (this.incidentTimer) {
        clearTimeout(this.incidentTimer);
        this.incidentTimer = null;
      }
      return;
    }
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

    // V1.18 — Retour au premier plan toujours déconnecté : on redémarre la fenêtre
    // de surveillance à MAINTENANT (le temps passé en arrière-plan ne doit pas
    // compter) puis on ré-arme le timer. Un incident « live interrompu » n'est donc
    // remonté que si la reconnexion échoue réellement au-delà du seuil, sous les yeux
    // de l'utilisateur. La reconnexion elle-même (socket.connect ci-dessus) est inchangée.
    if (this.socket && !this.socket.connected && this.disconnectedSince !== null) {
      this.disconnectedSince = Date.now();
      this.armIncidentTimer();
    }
  });

  // Coalescing : on accumule les position updates et on flush via requestAnimationFrame.
  // 100 vehicules x 1 trame/s = 1 setSignal/frame au lieu de 100, sans perte d'info.
  // En arriere-plan, le browser throttle rAF a ~1Hz : amortissement naturel.
  private readonly positionBuffer = new Map<string, PositionUpdateEvent>();
  private flushScheduled = false;

  /**
   * Instant de RÉCEPTION (horloge du navigateur) de chaque trame bufferisée, indexé par
   * trackerId. Il est capturé À L'ARRIVÉE de l'event, pas au flush : le flush passe par
   * requestAnimationFrame, que le navigateur gèle en arrière-plan. Sans cette capture, un
   * onglet caché 20 min rejouerait tout son buffer au retour et daterait chaque trame de
   * MAINTENANT — un boîtier muet depuis le début de l'absence paraîtrait frais.
   *
   * Pourquoi une horloge de réception et non celle de la trame : `event.timestamp` est le
   * `deviceTime` du Coban (cf. positions.service : `frame.deviceTime.toISOString()`), une
   * horloge qui dérive (skew GPRS, RTC sans pile) et qui peut être DANS LE FUTUR. Le serveur,
   * lui, écrit `Tracker.lastSeenAt = new Date()` : la date de réception. Écraser `lastSeenAt`
   * avec l'horloge boîtier revenait donc à mélanger deux horloges dans le même champ — et un
   * boîtier en avance rendait sa propre dormance STRUCTURELLEMENT indétectable (l'âge calculé
   * restait négatif ou minuscule, `isTrackerOnline` tolérant explicitement un âge négatif).
   */
  private readonly positionReceivedAt = new Map<string, number>();

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
    // Armer la surveillance dès l'ouverture : couvre aussi le cas « jamais
    // connecté » (API injoignable au login) en plus des coupures ultérieures.
    this.startIncidentWatch();

    this.socket.on('connect', () => {
      this.connected.set(true);
      this.everConnected = true;
      this.serverKickReconnects = 0; // reconnexion réussie → on ré-autorise le self-heal
      this.clearIncidentWatch();
      this.loadInitialAlerts();
    });

    this.socket.on('disconnect', (reason: string) => {
      this.connected.set(false);
      this.lastDisconnectReason = reason;
      this.flapCount++;
      // Coupure initiée par le serveur : socket.io ne se reconnecte pas seul et le
      // refresh de `connect_error` ne court pas ici → on relance nous-mêmes (le plus
      // souvent le token du handshake a expiré). Les autres raisons (transport close,
      // ping timeout…) restent gérées par la reconnexion automatique de socket.io.
      if (reason === 'io server disconnect') this.scheduleReconnectAfterServerKick();
      this.startIncidentWatch();
    });

    // Token expire → socket.io reconnecte avec l'ancien token → rejet backend.
    // On refresh le JWT et on met a jour le handshake auth pour la prochaine tentative.
    this.socket.on('connect_error', async (err: Error) => {
      this.lastConnectError = (err?.message ?? 'connect_error').slice(0, 200);
      if (this.refreshingToken || !this.socket) return;
      this.refreshingToken = true;
      let refreshed = false;
      try {
        const newToken = await this.auth.tryRefresh();
        if (newToken && this.socket) {
          (this.socket.auth as Record<string, string>)['token'] = newToken;
          refreshed = true;
        }
      } catch {
        refreshed = false;
      } finally {
        this.refreshingToken = false;
      }
      if (refreshed) {
        this.connectErrorRefreshFailures = 0;
        return;
      }
      // #9 — echec du refresh (token de refresh expire/revoque). socket.io garde
      // reconnection:true : sans garde on boucle (connect_error -> tryRefresh ->
      // echec -> connect_error...) a l'infini, sans jamais deconnecter l'user (cas
      // d'un onglet carte live laisse ouvert). Apres MAX echecs, session expiree.
      this.connectErrorRefreshFailures++;
      if (this.connectErrorRefreshFailures >= RealtimeService.MAX_CONNECT_REFRESH_FAILURES) {
        this.handleSessionExpired();
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
          // Anti-spam : un seul toast critique actif par véhicule+type (ex. power-cut répété).
          dedupeKey: `${alert.vehicleId ?? 'fleet'}:${alert.type}`,
        });
        return;
      }

      this.toast.show({
        kind: alert.severity === 'WARNING' ? 'warning' : 'info',
        title: alert.title,
        message: alert.vehiclePlate ? `Véhicule ${alert.vehiclePlate}` : undefined,
        duration: pref.duration,
        dedupeKey: `${alert.vehicleId ?? 'fleet'}:${alert.type}`,
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

    // Fix veilleur — transition « en mouvement ». Le veilleur (room ops:fleet) ne reçoit
    // aucune position ; cet event booléen maintient l'état à jour pour griser le bouton.
    this.socket.on(WS_EVENTS.VEHICLE_MOVEMENT, (event: VehicleMovementEvent) => {
      const next = new Set(this._movingTrackerIds());
      if (event.moving) next.add(event.trackerId);
      else next.delete(event.trackerId);
      this._movingTrackerIds.set(next);
    });

    this.socket.on(WS_EVENTS.ENGINE_COMMAND_UPDATED, (event: EngineCommandUpdatedEvent) => {
      const next = new Map(this._engineCommandUpdates());
      next.set(event.trackerId, event);
      this._engineCommandUpdates.set(next);

      // Bug « garé = coupé » : on n'ajuste l'état coupé du bouton QUE pour les
      // commandes APP (MANUAL/SCHEDULER). Les events DEVICE_OBSERVED sont émis à
      // chaque coupure de contact (simple stationnement) et faisaient basculer le
      // bouton sur « Rallumer » à tort en live. Ils restent stockés ci-dessus
      // (engineCommandUpdates, pour l'audit) mais ne pilotent plus l'état coupé.
      if (event.source === 'DEVICE_OBSERVED') return;

      // Maintenir l'etat coupe TRI-ETAT (revue #1/#2), jamais de faux succes :
      //  - CUT ACKNOWLEDGED    -> 'coupe' confirme (ignition tombee / DEVICE_OBSERVED)
      //  - CUT SENT            -> 'en attente' (commande, pas encore confirmee)
      //  - CUT FAILED/REJECTED -> efface (echec d'envoi)
      //  - RESTORE SENT||ACK   -> efface des l'envoi : rallumer est toujours sur, on
      //    ne requiert pas de preuve device pour CESSER d'afficher "coupe" (sinon
      //    l'etat resterait colle, un RESTORE app n'etant jamais ACKNOWLEDGED).
      const active = new Set(this._cutActiveTrackerIds());
      const pending = new Set(this._cutPendingTrackerIds());
      const tid = event.trackerId;
      if (event.action === 'CUT') {
        if (event.status === 'ACKNOWLEDGED') {
          active.add(tid);
          pending.delete(tid);
        } else if (event.status === 'SENT') {
          // NB : on ne retire PAS de `active` (un CUT confirme ne doit pas etre
          // degrade par un SENT tardif/redondant ; priorite coupe > en attente).
          pending.add(tid);
        } else {
          active.delete(tid);
          pending.delete(tid);
        }
      } else if (event.action === 'RESTORE') {
        if (event.status === 'SENT' || event.status === 'ACKNOWLEDGED') {
          active.delete(tid);
          pending.delete(tid);
        }
      }
      this._cutActiveTrackerIds.set(active);
      this._cutPendingTrackerIds.set(pending);
    });
  }

  /**
   * Fix veilleur — amorce l'état « en mouvement » depuis une liste REST (hydratation au
   * chargement de /vehicles). Les transitions live `VEHICLE_MOVEMENT` prennent ensuite le
   * relais. Idempotent : recalcule l'appartenance de chaque tracker fourni.
   */
  seedMovingState(entries: { trackerId: string; moving: boolean }[]): void {
    const next = new Set(this._movingTrackerIds());
    for (const e of entries) {
      if (e.moving) next.add(e.trackerId);
      else next.delete(e.trackerId);
    }
    this._movingTrackerIds.set(next);
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
      this.toast.error('Échec de l\'acquittement', 'Reessayer depuis la liste des alertes');
    });
  }

  /**
   * #9 — Session expiree cote WS (refresh token mort) : on stoppe la reconnexion
   * et on deconnecte l'utilisateur, exactement comme l'intercepteur HTTP — sinon un
   * utilisateur qui n'a que la carte live ouverte reste sur une session zombie a
   * marteler /auth/refresh en boucle.
   */
  private handleSessionExpired(): void {
    this.connectErrorRefreshFailures = 0;
    this.disconnect();
    this.auth.logout();
    void this.router.navigate(['/login']);
  }

  /**
   * Reconnexion après une éjection serveur (`io server disconnect`). On rafraîchit le
   * token (le handshake réutilise l'ancien, souvent expiré) AVANT de relancer. Petit
   * délai pour laisser l'API redémarrer (cas redéploiement) et éviter une boucle serrée.
   * Au-delà de MAX éjections consécutives sans reconnexion réussie, le serveur nous
   * refuse durablement (compte suspendu/supprimé) → session expirée (logout propre).
   */
  private scheduleReconnectAfterServerKick(): void {
    if (this.serverKickTimer) return; // déjà programmé
    if (this.serverKickReconnects >= RealtimeService.MAX_SERVER_KICK_RECONNECTS) {
      this.handleSessionExpired();
      return;
    }
    this.serverKickReconnects++;
    this.serverKickTimer = setTimeout(async () => {
      this.serverKickTimer = null;
      if (!this.socket || this.socket.connected) return;
      try {
        const newToken = await this.auth.tryRefresh();
        if (newToken && this.socket) (this.socket.auth as Record<string, string>)['token'] = newToken;
      } catch {
        /* on tente quand même la reconnexion avec le token courant */
      }
      this.socket?.connect();
    }, 1000);
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
    this._cutPendingTrackerIds.set(new Set());
    this._movingTrackerIds.set(new Set());
    this.positionBuffer.clear();
    this.positionReceivedAt.clear();
    this.flushScheduled = false;
    this.lastToastByKey.clear();
    this.clearIncidentWatch();
    if (this.serverKickTimer) {
      clearTimeout(this.serverKickTimer);
      this.serverKickTimer = null;
    }
    this.serverKickReconnects = 0;
    this.flapCount = 0;
    this.everConnected = false;
    this.lastDisconnectReason = null;
    this.lastConnectError = null;
  }

  // ---------------------------------------------------------------------
  // Surveillance d'interruption du canal temps réel → centre d'alerte
  // ---------------------------------------------------------------------

  /** Démarre la surveillance (idempotent) : on note le début de la coupure. */
  private startIncidentWatch(): void {
    if (this.disconnectedSince !== null) return;
    this.disconnectedSince = Date.now();
    this.armIncidentTimer();
  }

  /**
   * (Ré)arme le timer de premier report — UNIQUEMENT si l'onglet est au premier
   * plan. En arrière-plan on n'arme pas : un socket coupé y est normal et le timer
   * serait de toute façon gelé/throttlé par le navigateur (=> downMs gonflé au
   * réveil). La reprise au retour visible est pilotée par `visibilityEffect`.
   */
  private armIncidentTimer(): void {
    if (this.incidentTimer) {
      clearTimeout(this.incidentTimer);
      this.incidentTimer = null;
    }
    if (typeof document !== 'undefined' && !this.visibility.isVisible()) return;
    this.incidentTimer = setTimeout(
      () => this.reportRealtimeIncident(),
      RealtimeService.INCIDENT_DELAY_MS,
    );
  }

  /** Arrête la surveillance (reconnexion ou logout). */
  private clearIncidentWatch(): void {
    if (this.incidentTimer) {
      clearTimeout(this.incidentTimer);
      this.incidentTimer = null;
    }
    this.disconnectedSince = null;
  }

  /**
   * Remonte un incident "live interrompu" au backend (centre d'alerte) puis
   * re-programme un report périodique tant que la coupure persiste. Best-effort :
   * si le HTTP est lui aussi indisponible, on échoue silencieusement (rien à
   * remonter d'utile, l'app entière est down).
   *
   * V1.18 — Garde de visibilité : on ne remonte JAMAIS en arrière-plan (le timer ne
   * devrait pas y courir, mais on se protège d'un déclenchement au réveil avec un
   * downMs gonflé). Un report ne reflète donc qu'une coupure réellement vécue au
   * premier plan par l'utilisateur.
   */
  private reportRealtimeIncident(): void {
    if (this.disconnectedSince === null) return; // reconnecté entre-temps
    if (typeof document !== 'undefined' && !this.visibility.isVisible()) {
      this.incidentTimer = null;
      return;
    }
    const downMs = Date.now() - this.disconnectedSince;
    const transport =
      (this.socket?.io?.engine as { transport?: { name?: string } } | undefined)?.transport?.name ?? undefined;
    firstValueFrom(
      this.http.post('/api/realtime/incident', {
        downMs,
        reason: this.lastDisconnectReason ?? undefined,
        transport,
        lastError: this.lastConnectError ?? undefined,
        flaps: this.flapCount,
        everConnected: this.everConnected,
      }),
    ).catch(() => {
      /* silent */
    });
    this.incidentTimer = setTimeout(
      () => this.reportRealtimeIncident(),
      RealtimeService.INCIDENT_REPEAT_MS,
    );
  }

  // ---------------------------------------------------------------------
  // Coalescing positions via requestAnimationFrame
  // ---------------------------------------------------------------------

  private bufferPosition(event: PositionUpdateEvent): void {
    this.positionBuffer.set(event.trackerId, event);
    // Horodater la RÉCEPTION ici et pas au flush : c'est le seul instant où l'on sait
    // vraiment quand le boîtier nous a parlé (le flush rAF peut arriver bien plus tard,
    // voire jamais tant que l'onglet est caché). Écrase l'entrée précédente comme le
    // buffer lui-même : seule la trame la plus récente par tracker sera appliquée.
    this.positionReceivedAt.set(event.trackerId, Date.now());
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

    // Incident FS-253 — garder le SNAPSHOT (`last*`) FRAIS depuis le flux WS. Sans ça,
    // `lastSeenAt`/`lastPositionAt`/`lastNoFixAt` restent GELÉS à l'hydratation : une voiture
    // qui perd le GPS en cours de session garde un snapshot périmé → le marqueur reste affiché
    // « vert/en ligne » (bug signalé) au lieu de refléter GPS_LOST / à l'arrêt. On met à jour
    // uniquement les entrées touchées par ce flush (les autres gardent leur référence).
    const snap = this.snapshot();
    let snapChanged = false;
    const nextSnap = snap.map((s) => {
      if (!s.trackerId) return s;
      const ev = this.positionBuffer.get(s.trackerId);
      if (!ev) return s;
      snapChanged = true;
      // Intégrité de la source de dormance — DEUX horloges, deux usages, ne jamais les mélanger :
      //  - `lastSeenAt` = « quand le boîtier nous a parlé » → horloge de RÉCEPTION (navigateur),
      //    seule alignée sur le serveur (`Tracker.lastSeenAt = new Date()`). C'est elle qui
      //    décide de la dormance et du grisage des commandes ; la dériver de l'horloge boîtier
      //    laissait un Coban en avance masquer indéfiniment son propre silence — et cette
      //    contamination survivait à tout, puisque le snapshot REST était ensuite réécrit à
      //    chaque trame live. Un boîtier muet reste donc muet, quoi qu'il raconte.
      //  - `lastPositionAt` / `lastNoFixAt` = dates d'OBSERVATION GPS (quand le fix a été pris /
      //    quand le lock a manqué) → elles GARDENT le timestamp de la trame. Les remplacer par
      //    l'heure de réception rendrait un fix rejoué après une coupure GPRS artificiellement
      //    frais et casserait la détection GPS_LOST (qui compare justement fix vs no_fix).
      const receivedAt = new Date(this.positionReceivedAt.get(s.trackerId) ?? Date.now()).toISOString();
      // Trame valide = nouveau fix GPS ; trame `no_fix` (valid=false) = boîtier vivant sans lock.
      return ev.valid
        ? { ...s, lastSeenAt: receivedAt, lastIgnition: ev.ignition, lastPositionAt: ev.timestamp,
            lastLat: ev.lat, lastLng: ev.lng, lastSpeedKmh: ev.speedKmh, lastHeading: ev.heading, lastValid: true }
        : { ...s, lastSeenAt: receivedAt, lastIgnition: ev.ignition, lastNoFixAt: ev.timestamp, lastValid: false };
    });

    this.positionBuffer.clear();
    this.positionReceivedAt.clear();
    this.positions.set(next);
    if (snapChanged) this.snapshot.set(nextSnap);
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
    // ⚠️ Espace dépôt (2026-08), lot A3 — un DEPOT n'a pas `vehicles_view` : ce
    // `GET /api/vehicles/snapshot` lui répond 403, et l'intercepteur global en fait
    // un bandeau rouge « Action impossible » à CHAQUE chargement de sa carte.
    //
    // Le refus est correct — c'est l'appel qui ne l'est pas. Deux dégâts : le dépôt
    // croit l'outil cassé, et surtout le journal se remplit de 403 LÉGITIMES, ceux-là
    // mêmes par lesquels on vérifie l'isolation. On ne noie pas le signal qui sert à
    // prouver la propriété qu'on tient à prouver.
    //
    // Le dépôt a son propre canal : `DepotLiveStore` lit `/depot/live` et rejoint les
    // salons `depot:mission:<id>`.
    if (this.auth.isDepot()) return;
    try {
      // Sprint 3 (revue C1) — capture de l'état coupe AVANT le fetch snapshot. Le snapshot
      // peut être antérieur à un event WS arrivé pendant le round-trip ; on ré-appliquera
      // les deltas live après (cf. plus bas) pour ne PAS écraser une coupe/un rallumage
      // reçus entre-temps (sinon le bouton du veilleur repasse à tort sur « Couper »).
      const cutBefore = new Set(this._cutActiveTrackerIds());
      const pendingBefore = new Set(this._cutPendingTrackerIds());
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

      // Hydrater l'etat coupe TRI-ETAT depuis le snapshot (revue #2). engineCutState
      // ('normal'|'pending'|'cut') est la source ; fallback sur le booleen
      // engineCutActive pour la compat si le champ n'est pas encore servi.
      const cutIds = new Set<string>();
      const pendingIds = new Set<string>();
      for (const v of items) {
        if (!v.trackerId) continue;
        const st = v.engineCutState;
        if (st === 'cut' || (st == null && v.engineCutActive)) cutIds.add(v.trackerId);
        else if (st === 'pending') pendingIds.add(v.trackerId);
      }
      // Ré-applique les deltas WS survenus PENDANT le fetch (cf. capture cutBefore/pendingBefore) :
      // un tracker ajouté/retiré en live l'emporte sur le snapshot (potentiellement périmé) →
      // pas de boucle de re-coupe au retour d'onglet.
      const cutNow = this._cutActiveTrackerIds();
      const pendingNow = this._cutPendingTrackerIds();
      for (const id of cutNow) if (!cutBefore.has(id)) cutIds.add(id);
      for (const id of cutBefore) if (!cutNow.has(id)) cutIds.delete(id);
      for (const id of pendingNow) if (!pendingBefore.has(id)) pendingIds.add(id);
      for (const id of pendingBefore) if (!pendingNow.has(id)) pendingIds.delete(id);
      this._cutActiveTrackerIds.set(cutIds);
      this._cutPendingTrackerIds.set(pendingIds);

      this.positions.set(next);
      this.hydratedTrackerIds.set(hydratedIds);
      this.hydrated.set(true);
    } catch (err) {
      swallow('realtime:hydrate', err);
      // Silent — la carte se peuplera via WS.
    }
  }

  private async loadInitialAlerts(): Promise<void> {
    // Même raison que `hydrate()` : un DEPOT n'a pas `alerts_view`. Les alertes sont
    // l'outil du transporteur, jamais celui du tiers en lecture (A1 § 2).
    if (this.auth.isDepot()) return;
    try {
      const res = await firstValueFrom(
        this.http.get<{ items: AlertEvent[] }>('/api/alerts', {
          params: { acknowledged: 'false', limit: '50' },
        }),
      );
      this._alerts.set(res.items ?? []);
    } catch (err) {
      swallow('realtime:loadInitialAlerts', err);
      // Silent — alerts will come via WS
    }
  }
}
