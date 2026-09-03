import { swallow } from '../../core/error/swallow';
import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';
import type {
  AlertType,
  NotificationCategory,
  NotificationPreferenceDto,
  UpdateNotificationPreferenceDto,
} from '@vizyo/tracky-shared';
import { DEFAULT_MIN_SEVERITY, SEVERITY_ORDER } from '@vizyo/tracky-shared';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * Ce qu'il faut faire, au chargement, pour que le SERVEUR connaisse cet appareil.
 *
 *   - `resubscribe` : le navigateur n'a plus d'abonnement mais l'autorisation tient
 *     (iOS révoque silencieusement après ~2 semaines d'inactivité). On en recrée un,
 *     sans dialogue.
 *   - `reassert`    : le navigateur en a un. On le redéclare quand même, parce que le
 *     serveur a pu perdre le sien (purge d'administration, restauration). Sans ça,
 *     l'appareil reste « abonné » à l'écran et ne reçoit plus rien, définitivement.
 *   - `none`        : rien à faire, ou rien de possible sans redemander l'autorisation.
 *
 * ⚠️ Aucune branche ne déclenche de demande d'autorisation. Celle-ci ne se demande
 * QUE depuis un geste explicite de l'utilisateur (bouton « Activer ») — la redemander
 * au chargement serait perçu comme du harcèlement, et les navigateurs la refusent
 * définitivement après quelques rejets.
 */
export type PushSyncAction = 'resubscribe' | 'reassert' | 'none';

export function decidePushSync(input: {
  /** Le NAVIGATEUR détient-il un abonnement ? (jamais l'avis du serveur) */
  hasLocalSubscription: boolean;
  permission: NotificationPermission | 'unsupported';
}): PushSyncAction {
  if (input.hasLocalSubscription) return 'reassert';
  return input.permission === 'granted' ? 'resubscribe' : 'none';
}

export interface PushSubscriptionDto {
  id: string;
  endpoint: string;
  endpointHost: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  userRole: string | null;
  userAgent: string | null;
  lastSeenAt: string;
  createdAt: string;
  isMine: boolean;
}

export interface TestPushResultEntry {
  id: string;
  endpointHost: string;
  statusCode: number | null;
  error?: string;
}

export interface TestPushResponse {
  scheduled: boolean;
  delayMs: number;
  targetDevices: number;
  sent?: number;
  failed?: number;
  results?: TestPushResultEntry[];
}

export interface AlertRuleDto {
  id: string;
  fleetId: string;
  vehicleId: string | null;
  alertType: string;
  enabled: boolean;
  channels: ('IN_APP' | 'WEB_PUSH' | 'EMAIL' | 'WHATSAPP')[];
  escalateAfterMin: number | null;
  escalateToUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * V1.5 (Sprint M) — Service notifications cote frontend.
 *
 * Gestion du Web Push :
 *   1. registerServiceWorker() registre /sw.js (une fois au boot de l'app).
 *   2. subscribePush() demande la permission, genere une subscription, l'envoie
 *      au backend.
 *   3. unsubscribePush() retire la subscription locale + serveur.
 *
 * Gestion des AlertRules : list / create / update / delete via API.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsApiService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly swPush = inject(SwPush);

  readonly pushEnabled = signal<boolean | null>(null);
  readonly publicKey = signal<string | null>(null);
  readonly currentSubscription = signal<PushSubscription | null>(null);
  readonly devices = signal<PushSubscriptionDto[]>([]);
  readonly rules = signal<AlertRuleDto[]>([]);

  /**
   * Preferences PUSH du user courant, telles que le SERVEUR les applique au moment
   * d'aiguiller une alerte. `null` = jamais chargees.
   */
  readonly preferences = signal<NotificationPreferenceDto | null>(null);
  /**
   * Vrai quand le GET a echoue (API pas encore deployee, hors-ligne, 500...).
   * On affiche quand meme des valeurs par defaut pour que l'ecran reste utilisable,
   * mais l'UI doit DIRE que ce n'est pas la verite serveur — sinon l'utilisateur croit
   * avoir enregistre des reglages qui n'existent pas.
   */
  readonly preferencesUnavailable = signal(false);

  readonly isSubscribed = computed(() => this.currentSubscription() !== null);

  private swMessageBound = false;

  // ─── Service Worker + Push ──────────────────────────────────

  async loadStatus(): Promise<void> {
    try {
      const status = await firstValueFrom(
        this.http.get<{ enabled: boolean; publicKey: string | null }>('/api/notifications/push/public-key'),
      );
      this.pushEnabled.set(status.enabled);
      this.publicKey.set(status.publicKey);
      if (status.enabled && this.isPushSupported()) {
        await this.refreshSubscription();
        // iOS revoque silencieusement les subscriptions (apres 2 semaines d'inactivite
        // ou si le SW push handler n'a pas appele showNotification dans les temps).
        // Si l'utilisateur a deja accorde la permission mais qu'il n'y a plus de
        // subscription locale, on en cree une nouvelle silencieusement (pas besoin
        // de geste utilisateur tant que la permission est `granted`).
        const action = decidePushSync({
          hasLocalSubscription: this.isSubscribed(),
          permission: typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
        });
        if (action === 'resubscribe') {
          await this.silentResubscribe().catch(() => {/* silencieux : sera retente au prochain load */});
        } else if (action === 'reassert') {
          // ⚠️ RECONCILIATION AVEC LE SERVEUR — le cas que la branche precedente ne peut
          // PAS voir.
          //
          // `isSubscribed()` ne regarde QUE le navigateur (`pushManager.getSubscription`).
          // Le serveur n'est jamais consulte. Donc si sa table d'abonnements perd la ligne
          // — purge d'administration, restauration de sauvegarde, compte recree — pendant
          // que le navigateur garde le sien, on tombe dans un angle mort parfait :
          //   - `isSubscribed()` dit oui, donc pas de re-abonnement silencieux ;
          //   - le bandeau d'invitation ne s'affiche pas non plus (meme condition) ;
          //   - l'ecran de reglages affiche « abonne » ;
          //   - et le serveur ne connait plus l'appareil, donc plus AUCUN push.
          // Etat definitif, sans aucun signal, jusqu'a une desinscription manuelle.
          //
          // On re-affirme donc l'abonnement local a chaque chargement. C'est un `upsert`
          // sur l'endpoint cote serveur : idempotent, aucun doublon, et AUCUNE demande
          // d'autorisation (elle est deja accordee — on ne redemande jamais ce qu'on a).
          // Effet secondaire utile : `lastSeenAt` reste juste dans le centre d'administration.
          await this.reassertSubscription().catch(() => {/* sera retente au prochain load */});
        }
      }
    } catch (err) {
      swallow('notifications:loadStatus', err);
      this.pushEnabled.set(false);
    }
  }

  /**
   * Re-subscribe sans dialogue utilisateur. Exige `Notification.permission === 'granted'`
   * (sinon pushManager.subscribe leve). Utilise quand iOS a silencieusement revoque
   * la subscription mais que l'autorisation systeme est toujours active.
   */
  private async silentResubscribe(): Promise<void> {
    const key = this.publicKey();
    if (!key) return;
    const reg = await navigator.serviceWorker.getRegistration() ?? await this.registerServiceWorker();
    if (!reg) return;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.urlBase64ToUint8Array(key) as BufferSource,
    });
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
    if (!json.endpoint || !json.keys) return;
    await firstValueFrom(
      this.http.post('/api/notifications/push/subscribe', {
        subscription: { endpoint: json.endpoint, keys: json.keys },
        deviceId: this.getOrCreateDeviceId(),
      }),
    );
    this.currentSubscription.set(sub);
  }

  /**
   * Re-declare au serveur l'abonnement que le navigateur detient DEJA.
   *
   * Ne cree rien cote navigateur et ne demande aucune autorisation : on renvoie
   * simplement ce qu'on a. Cote serveur, `subscribe` est un `upsert` sur l'endpoint,
   * avec dedup par appareil — le rejouer est sans effet quand tout va bien, et repare
   * la desynchronisation quand la ligne serveur a disparu.
   */
  private async reassertSubscription(): Promise<void> {
    const sub = this.currentSubscription();
    if (!sub) return;
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
    if (!json.endpoint || !json.keys) return;
    await firstValueFrom(
      this.http.post('/api/notifications/push/subscribe', {
        subscription: { endpoint: json.endpoint, keys: json.keys },
        deviceId: this.getOrCreateDeviceId(),
      }),
    );
  }

  isPushSupported(): boolean {
    return typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;
  }

  /**
   * Detection iOS — couvre iPhone/iPad/iPod ainsi que les iPad recents qui
   * rapportent un UA macOS desktop ("Macintosh" + ecran tactile).
   */
  isIOS(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ se fait passer pour macOS Safari ; on detecte via le touch support.
    return ua.includes('Macintosh') && typeof document !== 'undefined' && 'ontouchend' in document;
  }

  /**
   * Vrai si la PWA tourne en mode standalone (ajoutee a l'ecran d'accueil iOS
   * ou installee comme app Android). Sur iOS, web push **n'est disponible
   * qu'en standalone** (Safari 16.4+) — c'est la cause #1 de "ca ne marche pas".
   */
  isStandalone(): boolean {
    if (typeof window === 'undefined') return false;
    try {
      if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    } catch {/* ignore */}
    return (navigator as { standalone?: boolean }).standalone === true;
  }

  /**
   * Version iOS majeure detectee depuis le UA, ou null si non-iOS ou inconnue.
   * Sert a diagnostiquer : web push exige iOS 16.4+.
   */
  iosVersion(): number | null {
    if (!this.isIOS()) return null;
    const ua = navigator.userAgent || '';
    // Format typique : "iPhone OS 17_5_1 like Mac OS X"
    const m = ua.match(/OS (\d+)[_.](\d+)/);
    if (!m) return null;
    const major = parseInt(m[1]!, 10);
    const minor = parseInt(m[2]!, 10);
    // Encode "16.4" -> 16.4 pour comparaison simple.
    return major + minor / 10;
  }

  /**
   * Inventaire des SW enregistres pour cette origine — sert a diagnostiquer
   * les conflits ngsw-worker vs /sw.js en prod (cause #1 du "FCM 201 mais
   * pas de notif sur Android"). Async car getRegistrations est une Promise.
   */
  async swRegistrations(): Promise<Array<{
    scriptURL: string;
    scope: string;
    state: 'installing' | 'waiting' | 'active' | 'unknown';
    isController: boolean;
  }>> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return [];
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      const controllerUrl = navigator.serviceWorker.controller?.scriptURL ?? null;
      const out: Array<{ scriptURL: string; scope: string; state: 'installing'|'waiting'|'active'|'unknown'; isController: boolean }> = [];
      for (const reg of regs) {
        const sw = reg.active ?? reg.waiting ?? reg.installing;
        if (!sw) continue;
        const state: 'installing'|'waiting'|'active' = reg.active === sw ? 'active'
          : reg.waiting === sw ? 'waiting'
          : 'installing';
        out.push({
          scriptURL: sw.scriptURL,
          scope: reg.scope,
          state,
          isController: sw.scriptURL === controllerUrl,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Resume diagnostic du support push sur le device courant.
   * Sert a alimenter l'UI Observabilite (et a expliquer a l'utilisateur
   * pourquoi rien n'arrive sur iOS sans PWA installee).
   */
  pushSupportDiagnostic(): {
    supported: boolean;
    reason?: string;
    permission: NotificationPermission | 'unsupported';
    isIOS: boolean;
    isStandalone: boolean;
    iosVersion: number | null;
    userAgent: string;
  } {
    const isIOSDevice = this.isIOS();
    const standalone = this.isStandalone();
    const ver = this.iosVersion();
    const permission: NotificationPermission | 'unsupported' =
      typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

    if (!this.isPushSupported()) {
      let reason: string;
      if (isIOSDevice && !standalone) {
        reason = 'iOS Safari : ajoute Tracky a l\'ecran d\'accueil (Partager → Ajouter), puis ouvre depuis la l\'icone.';
      } else if (isIOSDevice && ver !== null && ver < 16.4) {
        reason = `iOS ${ver} detecte — web push requiert iOS 16.4 ou superieur.`;
      } else if (isIOSDevice) {
        reason = 'iOS detecte mais PushManager indisponible — verifie que c\'est bien Safari (Chrome iOS ne supporte pas le push).';
      } else {
        reason = 'Ce navigateur ne supporte pas le Web Push.';
      }
      return { supported: false, reason, permission, isIOS: isIOSDevice, isStandalone: standalone, iosVersion: ver, userAgent: ua };
    }

    return { supported: true, permission, isIOS: isIOSDevice, isStandalone: standalone, iosVersion: ver, userAgent: ua };
  }

  async registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (!this.isPushSupported()) return null;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      this.installSwMessageBridge();
      return reg;
    } catch {
      return null;
    }
  }

  async refreshSubscription(): Promise<void> {
    if (!this.isPushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration() ?? await this.registerServiceWorker();
    if (!reg) return;
    this.installSwMessageBridge();
    const sub = await reg.pushManager.getSubscription();
    this.currentSubscription.set(sub);
  }

  /**
   * Pont SW -> client. Le SW poste 3 types de messages :
   *   - ACK_ALERT { alertId }   : acquittement declenche depuis l'action
   *                                "Acquitter" d'une notification systeme.
   *   - NAVIGATE  { url }       : fallback navigation si client.navigate() KO.
   *   - PUSH_RECEIVED { payload }: notif systeme affichee — utile pour rafraichir
   *                                la cloche meme si la WS est deconnectee.
   *
   * Idempotent : on s'attache une seule fois.
   */
  installSwMessageBridge(): void {
    if (this.swMessageBound || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    this.swMessageBound = true;
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string; alertId?: string; url?: string; payload?: unknown } | null;
      if (!data || typeof data !== 'object' || !data.type) return;

      if (data.type === 'ACK_ALERT' && data.alertId) {
        this.acknowledgeAlertFromSw(data.alertId);
        return;
      }
      if (data.type === 'NAVIGATE' && data.url) {
        this.router.navigateByUrl(data.url).catch(() => {/* ignore */});
        return;
      }
      if (data.type === 'PUSH_RECEIVED' && data.payload) {
        // Notre /sw.js dispatche ce message pour synchroniser l'UI quand WS
        // deconnectee. On en profite pour set le badge depuis le main thread :
        // sur iOS PWA standalone, setAppBadge depuis le SW context echoue
        // parfois silencieusement, l'appel main-thread est plus fiable.
        this.setAppBadgeFromPayload(data.payload);
        return;
      }
    });

    // ngsw-worker.js (Angular SW) dispatche les push events via SwPush.messages$
    // au lieu du message channel. Quand ngsw est le SW actif (ex: en PWA iOS
    // standalone si registre apres /sw.js), c'est lui qui recoit la push et
    // notifie le main thread via cette Observable. On set le badge ici.
    //
    // Note critique iOS : ces messages ne fire QUE quand un client est ouvert.
    // Pour set le badge en background, il faut que le SW (notre /sw.js OU
    // declarative web push iOS 18.4+) le fasse. Mais sur foreground (user vient
    // d'ouvrir l'app), ce listener garantit le badge.
    if (this.swPush.isEnabled) {
      this.swPush.messages.subscribe((payload) => {
        this.setAppBadgeFromPayload(payload);
      });
    }
  }

  /**
   * Lit `appBadge` dans un payload push (peut etre a la racine pour notre
   * format custom OU dans `notification.data.appBadge` pour le format ngsw)
   * et appelle setAppBadge / clearAppBadge en consequence.
   */
  private setAppBadgeFromPayload(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { appBadge?: number | null; notification?: { data?: { appBadge?: number | null } } };
    // Priorite : champ flat (notre format) -> notification.data.appBadge (format ngsw)
    const count = p.appBadge !== undefined ? p.appBadge : p.notification?.data?.appBadge;
    if (count === undefined) return; // pas de directive badge dans ce push
    try {
      const nav = navigator as Navigator & {
        setAppBadge?: (c: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };
      if (count === null) {
        nav.clearAppBadge?.().catch(() => {/* silencieux */});
      } else if (typeof count === 'number' && count > 0) {
        nav.setAppBadge?.(count).catch(() => {/* silencieux */});
      }
    } catch {/* feature absente */}
  }

  private async acknowledgeAlertFromSw(alertId: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`/api/alerts/${alertId}/acknowledge`, {}));
      this.toast.success('Alerte acquittee');
    } catch (err) {
      swallow('notifications:acknowledgeAlertFromSw', err);
      this.toast.error('Échec de l\'acquittement', 'Reessayer depuis la liste des alertes');
    }
  }

  async subscribePush(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.isPushSupported()) return { ok: false, reason: 'Push non supporte par ce navigateur' };

    // V1.10 (Sprint 4) — garantit que loadStatus a tourne avant requestPermission.
    // Sinon (si le caller invoque subscribePush sans avoir attendu loadStatus),
    // on risquait d'afficher la modale de permission browser puis de constater
    // que le serveur a push desactive => UX casse (permission demandee pour rien).
    if (this.pushEnabled() === null) {
      await this.loadStatus().catch(() => undefined);
    }

    const key = this.publicKey();
    if (!key) return { ok: false, reason: 'Push desactive cote serveur' };
    if (this.pushEnabled() !== true) return { ok: false, reason: 'Push desactive cote serveur' };

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { ok: false, reason: 'Permission refusee' };
    }

    const reg = await this.registerServiceWorker();
    if (!reg) return { ok: false, reason: 'Service Worker indisponible' };

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.urlBase64ToUint8Array(key) as BufferSource,
    });

    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
    if (!json.endpoint || !json.keys) return { ok: false, reason: 'Subscription invalide' };

    await firstValueFrom(
      this.http.post('/api/notifications/push/subscribe', {
        subscription: { endpoint: json.endpoint, keys: json.keys },
        deviceId: this.getOrCreateDeviceId(),
      }),
    );
    this.currentSubscription.set(sub);
    // Pre-charge l'audio CRITICAL : on est dans un handler d'interaction
    // utilisateur (clic Activer), c'est le moment optimal pour bypass
    // l'autoplay policy. Sans ca, le 1er son CRITICAL pourrait etre bloque.
    this.toast.primeCriticalAudio();
    return { ok: true };
  }

  /**
   * Recupere (ou genere puis stocke) l'UUID stable de ce device. Stocke en
   * localStorage qui survit aux sessions navigateur. Sert au backend a
   * dedupliquer les subscriptions par device physique : si l'utilisateur
   * reinstalle la PWA ou si l'endpoint rotate, la nouvelle sub remplace
   * proprement l'ancienne au lieu de creer un doublon zombie.
   *
   * Note : localStorage peut etre clear par l'utilisateur (parametres
   * navigateur) ou par iOS apres 7 jours sans visite (Intelligent Tracking
   * Prevention). Dans ces cas, on regenere un nouvel UUID, on aura
   * temporairement une nouvelle sub mais l'ancienne sera purgee par
   * 410 Gone au prochain envoi.
   */
  private getOrCreateDeviceId(): string {
    const KEY = 'tracky.device.id';
    try {
      const existing = localStorage.getItem(KEY);
      if (existing && /^[0-9a-f-]{8,64}$/i.test(existing)) return existing;
      // Genere via crypto.randomUUID() (RFC 4122 v4, support tous browsers 2026).
      const fresh = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, fresh);
      return fresh;
    } catch {
      // localStorage indisponible (private mode strict, etc.) — generer ad-hoc.
      // La dedup retombera sur userAgent server-side, moins precis mais OK.
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  }

  async unsubscribePush(): Promise<void> {
    const sub = this.currentSubscription();
    if (!sub) return;
    await sub.unsubscribe().catch(() => {/* ignore */});
    await firstValueFrom(
      this.http.request('DELETE', '/api/notifications/push/subscribe', {
        body: { endpoint: sub.endpoint },
      }),
    ).catch(() => {/* ignore */});
    this.currentSubscription.set(null);
  }

  /**
   * Recupere les subscriptions push.
   *   - `scope: 'mine'` (defaut) : uniquement celles du user courant
   *   - `scope: 'all'` : toutes (SUPER_ADMIN seulement, fail-soft si non autorise)
   */
  async listDevices(scope: 'mine' | 'all' = 'mine'): Promise<void> {
    const url = scope === 'all'
      ? '/api/notifications/push/subscriptions?scope=all'
      : '/api/notifications/push/subscriptions';
    const res = await firstValueFrom(
      this.http.get<{ items: PushSubscriptionDto[] }>(url),
    );
    this.devices.set(res.items);
  }

  /**
   * Lot V5 — notifications que l'utilisateur n'a PAS reçues faute d'appareil abonné,
   * sur sept jours. Le chiffre qui transforme « abonnez cet appareil » en « vous avez
   * manqué seize alertes cette semaine ».
   */
  undelivered(): Promise<{ noDevice7d: number; since: string }> {
    return firstValueFrom(this.http.get<{ noDevice7d: number; since: string }>('/api/notifications/push/undelivered'));
  }

  /**
   * Supprime une subscription par id. Owner ou SUPER_ADMIN cote backend.
   */
  async deleteDevice(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete(`/api/notifications/push/subscriptions/${id}`),
    );
    this.devices.set(this.devices().filter((d) => d.id !== id));
  }

  /**
   * Efface le badge sur l'icone de l'app (PWA installee).
   * A appeler quand l'utilisateur revient sur l'app — il a "vu" les notifs
   * en attente, donc on remet le compteur a 0.
   *
   * Support 2026 :
   *   - iOS 16.4+ standalone PWA : oui
   *   - Android Chrome PWA : oui
   *   - Chrome / Edge desktop : oui
   *   - Firefox / Safari non-PWA : silencieusement ignore
   */
  clearAppBadge(): void {
    try {
      if (typeof navigator !== 'undefined' && 'clearAppBadge' in navigator) {
        (navigator as { clearAppBadge?: () => Promise<void> }).clearAppBadge?.()
          .catch(() => {/* ignore */});
      }
    } catch {/* feature absente */}
  }

  /**
   * SUPER_ADMIN — envoie une notif push de test a l'utilisateur courant via
   * l'endpoint backend (qui gere le delai server-side). Permet de QA depuis
   * la page Observabilite. Le champ `results` n'est retourne que pour les
   * envois immediats (delayMs === 0) ; pour les envois differes, le backend
   * a deja repondu avant que le push parte.
   */
  sendTestPush(payload: {
    title?: string;
    body?: string;
    severity?: 'INFO' | 'WARNING' | 'CRITICAL';
    delayMs?: number;
    /** Liste optionnelle des subscription ids a cibler. Vide = toutes les subs du user. */
    subscriptionIds?: string[];
  }): Promise<TestPushResponse> {
    return firstValueFrom(
      this.http.post<TestPushResponse>('/api/notifications/test', payload),
    );
  }

  // ─── Preferences de notification PUSH ───────────────────────

  /**
   * Charge les preferences PUSH de l'utilisateur courant.
   *
   * Pourquoi un repli local plutot qu'une erreur : cet ecran est le SEUL endroit ou
   * l'utilisateur peut comprendre pourquoi il ne recoit rien. S'il tombe sur une page
   * vide parce que l'API a hoquete, on perd exactement l'information qu'on voulait lui
   * donner. On affiche donc les defauts, en signalant que le serveur n'a pas repondu.
   */
  async loadPreferences(): Promise<NotificationPreferenceDto> {
    try {
      const raw = await firstValueFrom(
        this.http.get<NotificationPreferenceDto>('/api/notifications/preferences'),
      );
      const pref = this.normalizePreference(raw);
      this.preferences.set(pref);
      this.preferencesUnavailable.set(false);
      return pref;
    } catch (err) {
      swallow('notifications:loadPreferences', err);
      const fallback = this.fallbackPreference();
      this.preferences.set(fallback);
      this.preferencesUnavailable.set(true);
      return fallback;
    }
  }

  /**
   * Enregistre une modification PARTIELLE (un seul interrupteur a la fois cote UI).
   *
   * Application optimiste : sur mobile, attendre l'aller-retour reseau avant de bouger
   * l'interrupteur donne l'impression que le tap n'a pas ete pris. On bouge tout de
   * suite et on REMET l'etat precedent si le serveur refuse — jamais d'etat affiche
   * qui ne correspond a rien.
   */
  async savePreferences(patch: UpdateNotificationPreferenceDto): Promise<boolean> {
    const previous = this.preferences();
    if (previous) {
      // `isDefault: false` des le premier changement : ce n'est plus un defaut applique
      // faute de mieux, c'est un choix de l'utilisateur.
      // `receivesFleetAlerts: null` du patch veut dire « selon mon role » : c'est une
      // instruction, pas une valeur affichable. On la retire de la fusion optimiste et on
      // laisse la reponse serveur trancher — sinon l'ecran afficherait `null` comme un etat.
      const { receivesFleetAlerts, ...rest } = patch;
      const optimistic: Partial<NotificationPreferenceDto> = { ...previous, ...rest, isDefault: false };
      if (typeof receivesFleetAlerts === 'boolean') {
        optimistic.receivesFleetAlerts = receivesFleetAlerts;
        optimistic.receivesFleetAlertsIsDefault = false;
      }
      this.preferences.set(this.normalizePreference(optimistic));
    }
    try {
      const saved = await firstValueFrom(
        this.http.put<NotificationPreferenceDto>('/api/notifications/preferences', patch),
      );
      this.preferences.set(this.normalizePreference(saved));
      this.preferencesUnavailable.set(false);
      return true;
    } catch (err) {
      swallow('notifications:savePreferences', err);
      if (previous) this.preferences.set(previous);
      return false;
    }
  }

  /**
   * Blinde une reponse serveur avant de la donner a l'UI : une API plus ancienne (ou une
   * reponse tronquee) qui renverrait `mutedTypes` absent ferait planter le `.includes()`
   * de l'ecran. Un ecran de reglages ne doit jamais casser sur une donnee partielle.
   */
  private normalizePreference(raw: Partial<NotificationPreferenceDto> | null | undefined): NotificationPreferenceDto {
    const minSeverity = raw?.minSeverity && SEVERITY_ORDER.includes(raw.minSeverity)
      ? raw.minSeverity
      : DEFAULT_MIN_SEVERITY;
    return {
      pushEnabled: raw?.pushEnabled !== false,
      minSeverity,
      mutedTypes: Array.isArray(raw?.mutedTypes) ? (raw.mutedTypes as AlertType[]) : [],
      // Une reponse d'API anterieure ne porte pas ce champ : « aucune famille coupee »
      // est le bon repli — il n'invente aucun silence que l'utilisateur n'aurait demande.
      mutedCategories: Array.isArray(raw?.mutedCategories)
        ? (raw.mutedCategories as NotificationCategory[])
        : [],
      isDefault: raw?.isDefault === true,
      eligible: raw?.eligible === true,
      deviceCount: typeof raw?.deviceCount === 'number' ? raw.deviceCount : 0,
      // Une API anterieure ne renvoie pas ces champs : on retombe sur « non destinataire,
      // valeur par defaut ». Prudent a dessein — on n'affiche jamais « vous recevez tout »
      // sur la foi d'une reponse incomplete.
      receivesFleetAlerts: raw?.receivesFleetAlerts === true,
      receivesFleetAlertsIsDefault: raw?.receivesFleetAlertsIsDefault !== false,
    };
  }

  /**
   * Valeurs affichees quand le serveur n'a pas repondu. `eligible: false` volontairement :
   * on ne PROMET pas une eligibilite qu'on n'a pas pu verifier. L'ecran donne la priorite
   * au message « reglages indisponibles » pour ne pas confondre les deux cas.
   */
  private fallbackPreference(): NotificationPreferenceDto {
    return {
      pushEnabled: true,
      minSeverity: DEFAULT_MIN_SEVERITY,
      mutedTypes: [],
      mutedCategories: [],
      isDefault: true,
      eligible: false,
      deviceCount: this.devices().filter((d) => d.isMine).length,
      // Prudent : on n'affirme pas que l'utilisateur est destinataire sans reponse serveur.
      receivesFleetAlerts: false,
      receivesFleetAlertsIsDefault: true,
    };
  }

  // ─── AlertRules CRUD ────────────────────────────────────────

  async listRules(): Promise<void> {
    const res = await firstValueFrom(
      this.http.get<{ items: AlertRuleDto[] }>('/api/notifications/rules'),
    );
    this.rules.set(res.items);
  }

  /**
   * ⚠️ `fleetId` est OBLIGATOIRE pour un SUPER_ADMIN, qui n'appartient à aucune flotte.
   *
   * Le backend accepte `params.fleetId ?? requestedBy.fleetId` : un chef de flotte n'a rien
   * à fournir, mais un super-admin sans `fleetId` reçoit un 400 « fleetId requis ». Ce champ
   * manquait purement et simplement à la signature — d'où l'impossibilité de créer la
   * moindre règle depuis un compte super-admin (constaté le 2026-07-28).
   */
  createRule(payload: {
    fleetId?: string | null;
    vehicleId?: string | null;
    alertType: string;
    enabled?: boolean;
    channels: string[];
    escalateAfterMin?: number | null;
    escalateToUserId?: string | null;
  }) {
    return firstValueFrom(this.http.post<AlertRuleDto>('/api/notifications/rules', payload));
  }

  updateRule(id: string, payload: {
    vehicleId?: string | null;
    alertType: string;
    enabled?: boolean;
    channels: string[];
    escalateAfterMin?: number | null;
    escalateToUserId?: string | null;
  }) {
    return firstValueFrom(this.http.put<AlertRuleDto>(`/api/notifications/rules/${id}`, payload));
  }

  deleteRule(id: string) {
    return firstValueFrom(this.http.delete(`/api/notifications/rules/${id}`));
  }

  // ─── Utils ──────────────────────────────────────────────────

  /** Convert VAPID public key (base64url) → Uint8Array required by PushManager. */
  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
}
