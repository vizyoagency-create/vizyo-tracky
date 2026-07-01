import { HttpClient } from '@angular/common/http';
import { DestroyRef, effect, inject, Injectable } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import type { ActivityEventInput } from '@vizyo/tracky-shared';
import { labelForRoute } from '@vizyo/tracky-shared';
import { filter, type Subscription } from 'rxjs';
import { activityContext } from './activity-context';
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
 * Palier 2 — Éléments considérés « cliquables » pour la CAPTURE AUTOMATIQUE du parcours.
 * Couvre boutons, liens, onglets, interrupteurs, listes déroulantes… sur toute l'app sans
 * instrumenter chaque template. Un élément peut porter `data-track="libellé"` pour un libellé
 * propre, ou `data-no-track` pour être exclu (zones sensibles / bruit).
 */
const INTERACTIVE_SELECTOR =
  'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="option"], input[type="submit"], input[type="button"], select, summary, [data-track]';

/** Throttle du tracking de défilement — 1 event / 5s / page (« limite les scrolls »). */
const SCROLL_THROTTLE_MS = 5_000;

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
  // Durée d'une page = temps ACTIF (onglet au premier plan), pas le temps horloge :
  // on accumule `pageActiveMs` et on ferme le segment courant quand l'onglet est caché.
  private pageActiveMs = 0;
  private lastVisibleAt = 0;
  private lastActivityAt = 0;
  /** Raison à joindre au prochain SESSION_END : 'manual' (user) | 'auto' (système/expiration) | 'tab_close'. */
  private pendingEndReason: string | null = null;
  private readonly deviceType = detectDeviceType();

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private awayTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private routerSub: Subscription | null = null;
  private readonly onActivity = () => this.handleUserActivity();
  private readonly onUnload = () => this.handleUnload();
  private readonly onDocClick = (e: Event) => this.handleDocClick(e);
  private readonly onDocScroll = (e: Event) => this.handleScroll(e);
  private readonly onSubmit = (e: Event) => this.handleSubmit(e);
  private lastScrollAt = 0;

  constructor() {
    // Démarre quand l'utilisateur est authentifié, arrête sinon (logout).
    effect(() => {
      if (this.auth.isAuthenticated()) this.start();
      else this.stop();
    });
    // Présence + comptage du temps ACTIF pilotés par la visibilité de l'onglet.
    effect(() => {
      const visible = this.visibility.isVisible();
      if (!this.started) return;
      if (visible) {
        this.lastVisibleAt = Date.now(); // reprend le décompte actif de la page
        this.handleUserActivity();
      } else {
        this.accrueActive(); // fige le temps actif quand l'onglet passe en arrière-plan
        this.setStatus('AWAY');
      }
    });
    this.destroyRef.onDestroy(() => this.stop());
  }

  /** Appelé par la directive [trackClick] (libellé explicite, prioritaire). */
  trackClick(target: string): void {
    if (!this.started || !target) return;
    this.push({ type: 'CLICK', target, route: this.currentRoute ?? undefined });
    this.handleUserActivity();
  }

  /**
   * Le shell signale une déconnexion VOLONTAIRE (clic « Se déconnecter ») avant de couper la
   * session, pour que le SESSION_END porte la bonne raison. Sans appel, une coupure de session
   * (expiration/token invalide) est journalisée comme 'auto'.
   */
  markSessionEnd(reason: string): void {
    this.pendingEndReason = reason;
  }

  /**
   * Palier 2 — capture automatique d'un clic sur un élément interactif. Dérive un libellé
   * lisible (data-track > aria-label > texte > titre). Ignore les éléments gérés par la
   * directive [trackClick] (anti-doublon) et les sous-arbres `data-no-track`.
   */
  private handleDocClick(e: Event): void {
    if (!this.started) return;
    const origin = (e.composedPath?.()[0] as Element | undefined) ?? (e.target as Element | null);
    if (!origin || typeof origin.closest !== 'function') return;
    if (origin.closest('[data-no-track]')) return;
    // 1. élément interactif standard (bouton/lien/onglet…). 2. sinon fallback : élément custom
    // cliquable détecté par `cursor: pointer` → capture les <div>/<tr>/<li> à handler (click) sur
    // toute l'app SANS instrumenter chaque template.
    const el = origin.closest(INTERACTIVE_SELECTOR) ?? findPointerAncestor(origin);
    if (!el || el.closest('[trackclick]')) return;
    const target = deriveClickLabel(el);
    if (!target) return;
    this.push({ type: 'CLICK', target, route: this.currentRoute ?? undefined });
    // La présence (ACTIVE) est déjà rafraîchie par le listener 'click' de ACTIVITY_EVENTS.
  }

  /** Capture (throttlée) du défilement — page + profondeur % (« limite les scrolls »). */
  private handleScroll(e: Event): void {
    if (!this.started) return;
    const now = Date.now();
    if (now - this.lastScrollAt < SCROLL_THROTTLE_MS) return;
    this.lastScrollAt = now;
    const t = e.target;
    const se = t === document || t == null ? document.scrollingElement : (t as Element);
    let depth = 0;
    if (se && 'scrollHeight' in se) {
      const s = se as unknown as { scrollTop: number; scrollHeight: number; clientHeight: number };
      const max = s.scrollHeight - s.clientHeight;
      depth = max > 0 ? Math.min(100, Math.max(0, Math.round((s.scrollTop / max) * 100))) : 0;
    }
    this.push({ type: 'SCROLL', route: this.currentRoute ?? undefined, target: `${depth}%` });
  }

  /** Capture d'une soumission de formulaire (action manuelle distincte d'un simple clic). */
  private handleSubmit(e: Event): void {
    if (!this.started) return;
    const form = e.target as Element | null;
    if (!form || (form.closest && form.closest('[data-no-track]'))) return;
    const label =
      form.getAttribute?.('data-track') ||
      form.getAttribute?.('aria-label') ||
      form.getAttribute?.('name') ||
      'formulaire';
    this.push({ type: 'FORM_SUBMIT', route: this.currentRoute ?? undefined, target: label.slice(0, 60) });
  }

  // ---------------------------------------------------------------------

  private start(): void {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.status = 'ACTIVE';
    this.lastActivityAt = Date.now();
    this.currentRoute = this.router.url;
    this.resetPageTiming();
    // Identifiant de corrélation session (côté client) : attaché aux requêtes
    // + aux erreurs pour relier une erreur à ce que faisait l'utilisateur.
    activityContext.sessionId = randomId();
    activityContext.route = this.currentRoute;

    this.push({ type: 'SESSION_START' });
    this.pushHeartbeat(); // pose la route courante côté serveur immédiatement

    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.handleNavigation(e.urlAfterRedirects));

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, this.onActivity, { passive: true });
    }
    // Palier 2 — capture automatique des clics (parcours complet). Phase de capture pour
    // l'attraper même si un handler stoppe la propagation. La directive [trackClick] reste
    // prioritaire (ses éléments sont ignorés ici pour éviter le doublon).
    document.addEventListener('click', this.onDocClick, { capture: true, passive: true });
    document.addEventListener('scroll', this.onDocScroll, { capture: true, passive: true });
    document.addEventListener('submit', this.onSubmit, { capture: true });
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
    this.push({ type: 'SESSION_END', target: this.pendingEndReason ?? 'auto' });
    this.pendingEndReason = null;
    this.flush();
    this.routerSub?.unsubscribe();
    this.routerSub = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.awayTimer) clearTimeout(this.awayTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.idleTimer = this.awayTimer = this.heartbeatTimer = this.flushTimer = null;
    for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, this.onActivity);
    document.removeEventListener('click', this.onDocClick, { capture: true } as EventListenerOptions);
    document.removeEventListener('scroll', this.onDocScroll, { capture: true } as EventListenerOptions);
    document.removeEventListener('submit', this.onSubmit, { capture: true } as EventListenerOptions);
    window.removeEventListener('pagehide', this.onUnload);
    window.removeEventListener('beforeunload', this.onUnload);
    this.started = false;
    this.currentRoute = null;
    activityContext.sessionId = null;
    activityContext.route = null;
  }

  private handleNavigation(url: string): void {
    if (url === this.currentRoute) return;
    this.handleNavigationDuration();
    this.currentRoute = url;
    activityContext.route = url;
    this.resetPageTiming();
    this.pushHeartbeat(); // met à jour la route courante côté serveur sans attendre 30s
    this.handleUserActivity();
  }

  /** Émet le PAGE_VIEW de la page quittée avec sa durée ACTIVE (temps onglet au premier plan). */
  private handleNavigationDuration(): void {
    if (!this.currentRoute) return;
    const durationMs = Math.min(this.currentPageActiveMs(), 86_400_000);
    this.push({
      type: 'PAGE_VIEW',
      route: this.currentRoute,
      routeLabel: labelForRoute(this.currentRoute),
      durationMs,
    });
  }

  /** (Ré)initialise le décompte de temps actif à l'entrée d'une page. */
  private resetPageTiming(): void {
    this.pageActiveMs = 0;
    this.lastVisibleAt = this.visibility.isVisible() ? Date.now() : 0;
  }

  /** Fige le segment actif courant (onglet qui passe en arrière-plan). */
  private accrueActive(): void {
    if (this.lastVisibleAt > 0) {
      this.pageActiveMs += Math.max(0, Date.now() - this.lastVisibleAt);
      this.lastVisibleAt = 0;
    }
  }

  /** Temps actif cumulé de la page courante (segments passés + segment visible en cours). */
  private currentPageActiveMs(): number {
    const live = this.lastVisibleAt > 0 ? Math.max(0, Date.now() - this.lastVisibleAt) : 0;
    return this.pageActiveMs + live;
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
    this.push({ type: 'SESSION_END', target: 'tab_close' });
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

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fallback below */
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Remonte jusqu'à ~4 niveaux pour trouver un élément custom cliquable (cursor:pointer). */
function findPointerAncestor(start: Element): Element | null {
  let el: Element | null = start;
  for (let i = 0; el && i < 4; i++) {
    if (el instanceof HTMLElement) {
      try {
        if (getComputedStyle(el).cursor === 'pointer') return el;
      } catch {
        /* getComputedStyle peut échouer sur un nœud détaché */
      }
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Palier 2 — libellé lisible d'un élément cliqué (capture auto du parcours) :
 * data-track > aria-label > texte visible (tronqué) > title > rôle/tag.
 */
function deriveClickLabel(el: Element): string | null {
  const dt = el.getAttribute('data-track');
  if (dt?.trim()) return dt.trim().slice(0, 60);
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return aria.trim().slice(0, 60);
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 60);
  const title = el.getAttribute('title');
  if (title?.trim()) return title.trim().slice(0, 60);
  const role = el.getAttribute('role');
  return role || el.tagName.toLowerCase();
}

function detectDeviceType(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}
