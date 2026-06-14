import { HttpClient } from '@angular/common/http';
import { DestroyRef, effect, inject, Injectable } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import type { ActivityEventInput } from '@vizyo/tracky-shared';
import { labelForRoute } from '@vizyo/tracky-shared';
import { filter, type Subscription } from 'rxjs';
import { AuthService } from './auth.service';
import { VisibilityService } from './visibility.service';

type Status = 'ACTIVE' | 'IDLE' | 'AWAY';

const IDLE_MS = 2 * 60 * 1000;
const AWAY_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const FLUSH_MS = 10 * 1000;
const ACTIVITY_THROTTLE_MS = 2 * 1000;
const FLUSH_AT = 20;
const BUFFER_CAP = 200;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'] as const;

/**
 * Tracking d'activité utilisateur (transparent). Démarre/s'arrête selon l'état
 * d'authentification. Collecte la navigation (PAGE_VIEW + durée), la présence
 * (ACTIVE/IDLE/AWAY via inactivité + Page Visibility), un heartbeat (route
 * courante), et bufferise le tout en POST batch. `flush` final via sendBeacon
 * à la fermeture. Aucun WebSocket : l'admin lit par polling.
 */
@Injectable({ providedIn: 'root' })
export class ActivityTrackerService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly visibility = inject(VisibilityService);
  private readonly destroyRef = inject(DestroyRef);

  private started = false;
  private buffer: ActivityEventInput[] = [];
  private status: Status = 'ACTIVE';
  private currentRoute: string | null = null;
  private pageEnterAt = 0;
  private lastActivityAt = 0;
  private readonly deviceType = detectDeviceType();

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private awayTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private routerSub: Subscription | null = null;
  private readonly onActivity = () => this.handleUserActivity();
  private readonly onUnload = () => this.handleUnload();

  constructor() {
    // Démarre quand l'utilisateur est authentifié, arrête sinon (logout).
    effect(() => {
      if (this.auth.isAuthenticated()) this.start();
      else this.stop();
    });
    // Présence pilotée par la visibilité de l'onglet.
    effect(() => {
      const visible = this.visibility.isVisible();
      if (!this.started) return;
      if (visible) this.handleUserActivity();
      else this.setStatus('AWAY');
    });
    this.destroyRef.onDestroy(() => this.stop());
  }

  /** Appelé par la directive [trackClick]. */
  trackClick(target: string): void {
    if (!this.started || !target) return;
    this.push({ type: 'CLICK', target, route: this.currentRoute ?? undefined });
    this.handleUserActivity();
  }

  // ---------------------------------------------------------------------

  private start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.status = 'ACTIVE';
    this.lastActivityAt = Date.now();
    this.currentRoute = this.router.url;
    this.pageEnterAt = Date.now();

    this.push({ type: 'SESSION_START' });
    this.pushHeartbeat(); // pose la route courante côté serveur immédiatement

    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.handleNavigation(e.urlAfterRedirects));

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, this.onActivity, { passive: true });
    }
    window.addEventListener('pagehide', this.onUnload);
    window.addEventListener('beforeunload', this.onUnload);

    this.armIdleTimers();
    this.heartbeatTimer = setInterval(() => {
      this.pushHeartbeat();
      this.flush();
    }, HEARTBEAT_MS);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
  }

  private stop(): void {
    if (!this.started) return;
    this.handleNavigationDuration(); // clôt la page courante
    this.push({ type: 'SESSION_END' });
    this.flush();
    this.routerSub?.unsubscribe();
    this.routerSub = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.awayTimer) clearTimeout(this.awayTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.idleTimer = this.awayTimer = this.heartbeatTimer = this.flushTimer = null;
    for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, this.onActivity);
    window.removeEventListener('pagehide', this.onUnload);
    window.removeEventListener('beforeunload', this.onUnload);
    this.started = false;
    this.currentRoute = null;
  }

  private handleNavigation(url: string): void {
    if (url === this.currentRoute) return;
    this.handleNavigationDuration();
    this.currentRoute = url;
    this.pageEnterAt = Date.now();
    this.pushHeartbeat(); // met à jour la route courante côté serveur sans attendre 30s
    this.handleUserActivity();
  }

  /** Émet le PAGE_VIEW de la page quittée avec sa durée (analytics). */
  private handleNavigationDuration(): void {
    if (!this.currentRoute) return;
    const durationMs = Math.max(0, Date.now() - this.pageEnterAt);
    this.push({
      type: 'PAGE_VIEW',
      route: this.currentRoute,
      routeLabel: labelForRoute(this.currentRoute),
      durationMs,
    });
  }

  private handleUserActivity(): void {
    const now = Date.now();
    if (now - this.lastActivityAt < ACTIVITY_THROTTLE_MS) {
      this.lastActivityAt = now;
      return;
    }
    this.lastActivityAt = now;
    if (this.status !== 'ACTIVE') {
      this.setStatus('ACTIVE');
      this.push({ type: 'SESSION_RESUME' });
    }
    this.armIdleTimers();
  }

  private armIdleTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.awayTimer) clearTimeout(this.awayTimer);
    this.idleTimer = setTimeout(() => this.setStatus('IDLE'), IDLE_MS);
    this.awayTimer = setTimeout(() => this.setStatus('AWAY'), AWAY_MS);
  }

  private setStatus(s: Status): void {
    if (this.status === s) return;
    this.status = s;
    if (s === 'IDLE') this.push({ type: 'IDLE', status: 'IDLE' });
    else if (s === 'AWAY') this.push({ type: 'AWAY', status: 'AWAY' });
  }

  private pushHeartbeat(): void {
    this.push({ type: 'HEARTBEAT', status: this.status, route: this.currentRoute ?? undefined });
  }

  private push(event: ActivityEventInput): void {
    if (this.buffer.length >= BUFFER_CAP) this.buffer.shift();
    this.buffer.push({ ...event, at: new Date().toISOString() });
    if (this.buffer.length >= FLUSH_AT) this.flush();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    this.http
      .post('/api/activity/batch', { events, deviceType: this.deviceType })
      .subscribe({
        error: () => {
          // Remet les events en tête pour réessayer au prochain flush (capé).
          this.buffer = [...events, ...this.buffer].slice(-BUFFER_CAP);
        },
      });
  }

  /** Fermeture de l'onglet : envoi best-effort via sendBeacon (cookie auth). */
  private handleUnload(): void {
    if (!this.started) return;
    this.handleNavigationDuration();
    this.push({ type: 'SESSION_END' });
    const payload = { events: this.buffer, deviceType: this.deviceType };
    this.buffer = [];
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon?.('/api/activity/batch', blob);
    } catch {
      /* best-effort */
    }
  }
}

function detectDeviceType(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}
