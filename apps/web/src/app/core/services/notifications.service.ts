import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ToastService } from '../../shared/ui/toast/toast.service';

export interface PushSubscriptionDto {
  id: string;
  endpoint: string;
  userAgent: string | null;
  lastSeenAt: string;
  createdAt: string;
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

  readonly pushEnabled = signal<boolean | null>(null);
  readonly publicKey = signal<string | null>(null);
  readonly currentSubscription = signal<PushSubscription | null>(null);
  readonly devices = signal<PushSubscriptionDto[]>([]);
  readonly rules = signal<AlertRuleDto[]>([]);

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
        if (!this.isSubscribed() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          await this.silentResubscribe().catch(() => {/* silencieux : sera retente au prochain load */});
        }
      }
    } catch {
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
      }),
    );
    this.currentSubscription.set(sub);
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
      const data = event.data as { type?: string; alertId?: string; url?: string } | null;
      if (!data || typeof data !== 'object' || !data.type) return;

      if (data.type === 'ACK_ALERT' && data.alertId) {
        this.acknowledgeAlertFromSw(data.alertId);
        return;
      }
      if (data.type === 'NAVIGATE' && data.url) {
        this.router.navigateByUrl(data.url).catch(() => {/* ignore */});
        return;
      }
      // PUSH_RECEIVED : on laisse les autres services (RealtimeService) reagir
      // s'ils ont leur propre listener — pas d'action centrale ici.
    });
  }

  private async acknowledgeAlertFromSw(alertId: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`/api/alerts/${alertId}/acknowledge`, {}));
      this.toast.success('Alerte acquittee');
    } catch {
      this.toast.error('Echec de l\'acquittement', 'Reessayer depuis la liste des alertes');
    }
  }

  async subscribePush(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.isPushSupported()) return { ok: false, reason: 'Push non supporte par ce navigateur' };
    const key = this.publicKey();
    if (!key) return { ok: false, reason: 'Push desactive cote serveur' };

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
      }),
    );
    this.currentSubscription.set(sub);
    // Pre-charge l'audio CRITICAL : on est dans un handler d'interaction
    // utilisateur (clic Activer), c'est le moment optimal pour bypass
    // l'autoplay policy. Sans ca, le 1er son CRITICAL pourrait etre bloque.
    this.toast.primeCriticalAudio();
    return { ok: true };
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

  async listDevices(): Promise<void> {
    const res = await firstValueFrom(
      this.http.get<{ items: PushSubscriptionDto[] }>('/api/notifications/push/subscriptions'),
    );
    this.devices.set(res.items);
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
  }): Promise<TestPushResponse> {
    return firstValueFrom(
      this.http.post<TestPushResponse>('/api/notifications/test', payload),
    );
  }

  // ─── AlertRules CRUD ────────────────────────────────────────

  async listRules(): Promise<void> {
    const res = await firstValueFrom(
      this.http.get<{ items: AlertRuleDto[] }>('/api/notifications/rules'),
    );
    this.rules.set(res.items);
  }

  createRule(payload: {
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
