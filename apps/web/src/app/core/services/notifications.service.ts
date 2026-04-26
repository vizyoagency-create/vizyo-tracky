import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface PushSubscriptionDto {
  id: string;
  endpoint: string;
  userAgent: string | null;
  lastSeenAt: string;
  createdAt: string;
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

  readonly pushEnabled = signal<boolean | null>(null);
  readonly publicKey = signal<string | null>(null);
  readonly currentSubscription = signal<PushSubscription | null>(null);
  readonly devices = signal<PushSubscriptionDto[]>([]);
  readonly rules = signal<AlertRuleDto[]>([]);

  readonly isSubscribed = computed(() => this.currentSubscription() !== null);

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
      }
    } catch {
      this.pushEnabled.set(false);
    }
  }

  isPushSupported(): boolean {
    return typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;
  }

  async registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (!this.isPushSupported()) return null;
    try {
      return await navigator.serviceWorker.register('/sw.js');
    } catch {
      return null;
    }
  }

  async refreshSubscription(): Promise<void> {
    if (!this.isPushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration() ?? await this.registerServiceWorker();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    this.currentSubscription.set(sub);
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
