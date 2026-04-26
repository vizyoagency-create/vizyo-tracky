import { Injectable, signal } from '@angular/core';

/**
 * V1.5 (Sprint H2) — Detection de visibilite et d'activite utilisateur.
 *
 * Expose deux signaux reactifs :
 *   - isVisible      : true si l'onglet est au premier plan (Page Visibility API).
 *   - isUserActive   : true si une interaction utilisateur a eu lieu < 5 min
 *                      (mouse, keyboard, touch, focus). Reset par hidden.
 *
 * Egalement : `lastHiddenSinceMs()` retourne la duree depuis le dernier passage
 * a hidden quand on est visible (utile pour decider d'une re-hydratation).
 *
 * Decision UX (cf. roadmap §13) : on **maintient** la connexion WebSocket meme
 * onglet cache. Le service ne touche pas au socket — il sert juste de signal
 * pour pauser les boucles UI couteuses (RAF, interpolation).
 */

const ACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const ACTIVITY_EVENTS: (keyof DocumentEventMap | keyof WindowEventMap)[] = [
  'mousemove',
  'keydown',
  'touchstart',
  'wheel',
];

@Injectable({ providedIn: 'root' })
export class VisibilityService {
  readonly isVisible = signal<boolean>(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true);
  readonly isUserActive = signal<boolean>(true);

  /** Wall-clock when the tab last transitioned hidden -> visible. null on first load. */
  private lastVisibleAt: number | null = null;
  /** Wall-clock when the tab last transitioned visible -> hidden. null while visible. */
  private lastHiddenAt: number | null = null;
  private lastActivityAt: number = Date.now();
  private activityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof document === 'undefined') return;

    const onVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';
      if (visible && !this.isVisible()) {
        this.lastVisibleAt = Date.now();
      } else if (!visible && this.isVisible()) {
        this.lastHiddenAt = Date.now();
      }
      this.isVisible.set(visible);
      if (!visible) {
        // Reset activity tracking when the tab is backgrounded.
        this.isUserActive.set(false);
      } else {
        // Coming back foreground re-arms activity (the user just acted on the tab).
        this.markActive();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const onActivity = () => this.markActive();
    for (const ev of ACTIVITY_EVENTS) {
      document.addEventListener(ev as string, onActivity, { passive: true });
    }
    window.addEventListener('focus', onActivity);
    // Service is providedIn: 'root' — lifetime = app lifetime, no cleanup needed.
  }

  /** Time elapsed since the tab was hidden (and just came back). 0 if visible without prior hidden, null if currently hidden. */
  lastHiddenDurationMs(): number | null {
    if (!this.isVisible()) return null;
    if (!this.lastHiddenAt) return 0;
    if (!this.lastVisibleAt) return 0;
    return Math.max(0, this.lastVisibleAt - this.lastHiddenAt);
  }

  private markActive(): void {
    this.lastActivityAt = Date.now();
    if (!this.isUserActive()) this.isUserActive.set(true);
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => {
      const idle = Date.now() - this.lastActivityAt;
      if (idle >= ACTIVITY_TIMEOUT_MS) {
        this.isUserActive.set(false);
      }
    }, ACTIVITY_TIMEOUT_MS);
  }
}
