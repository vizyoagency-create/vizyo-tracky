import { ErrorHandler, Injectable, inject, isDevMode } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { activityContext } from '../services/activity-context';

/**
 * V1.10 (Sprint 5 stabilite) — ErrorHandler global pour Tracky.
 *
 * Avant : une erreur uncaught (sync, dans un effect, dans un setTimeout, dans
 * une Promise non chainee) s'imprimait silencieusement dans la console et
 * l'utilisateur ne voyait rien. Le syndrome "j'ai cliqué, rien ne se passe"
 * remonte par les clients venait souvent d'une exception silencieuse en JS.
 *
 * Maintenant : on log toujours en console (en dev avec stack, en prod compact),
 * et on toast une notification d'erreur generique pour que l'utilisateur sache
 * que quelque chose a foire et qu'il faut soit recharger soit prevenir.
 *
 * Cas filtres (pas de toast — bruit inutile) :
 *   - HttpErrorResponse : les interceptors HTTP les gerent (toast plus precis,
 *     ou silence intentionnel selon le contexte).
 *   - Erreurs avec `name === 'AbortError'` : annulations volontaires (fetch
 *     abort, signal cancellation).
 *   - Promise unhandled de chargements lazy : navigateur a deja un fallback.
 *
 * Dedup : pour eviter qu'une erreur en cascade affiche 10 toasts en serie,
 * on memorise le message du dernier toast affiche et on skip pendant 3s.
 */

let lastErrorMessage: string | null = null;
let lastErrorAt = 0;
const DEDUP_WINDOW_MS = 3_000;

// Dedup séparé pour la remontée serveur (évite d'inonder le centre d'alerte).
let lastReportMessage: string | null = null;
let lastReportAt = 0;
const REPORT_DEDUP_MS = 15_000;

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly toast = inject(ToastService);

  handleError(error: unknown): void {
    // 1. Toujours logger — en dev avec stack pour debug, en prod compact.
    if (isDevMode()) {
      console.error('[GlobalErrorHandler]', error);
    } else {
      const msg = this.describe(error);
      console.error(`[GlobalErrorHandler] ${msg}`);
    }

    // 1bis. Remonter au backend avec le contexte user/page/session (centre
    // d'alerte). On ne remonte que les erreurs JS côté client : les
    // HttpErrorResponse 5xx sont déjà journalisées côté serveur.
    this.reportToServer(error);

    // 2. Filtres : ne pas toaster les erreurs deja gerees ou non actionnables.
    if (this.shouldSkipToast(error)) return;

    // 3. Dedup : eviter 10 toasts en cascade pour la meme erreur.
    const message = this.describe(error);
    const now = Date.now();
    if (lastErrorMessage === message && now - lastErrorAt < DEDUP_WINDOW_MS) return;
    lastErrorMessage = message;
    lastErrorAt = now;

    // 4. Toast user — message volontairement generique, le user n'a pas besoin
    // de voir la stack technique. Le detail est dans la console pour le dev.
    this.toast.error(
      'Une erreur est survenue',
      'Recharge la page si le probleme persiste.',
    );
  }

  /** Remonte une erreur JS client au backend avec le contexte page/session. */
  private reportToServer(error: unknown): void {
    // On saute les HttpError (déjà journalisées serveur) et les Abort, et on ne
    // remonte que si une session est active (authentifié) pour éviter le bruit.
    if (this.shouldSkipToast(error) || !activityContext.sessionId) return;

    const message = this.describe(error).slice(0, 2000);
    const now = Date.now();
    // #38 — cle de dedup incluant le sessionId : sinon la meme erreur recurrente
    // d'une NOUVELLE session (re-login / autre user) etait suppressee a tort par cet
    // etat module-global. Une nouvelle session re-rapporte donc l'erreur.
    const dedupKey = `${activityContext.sessionId ?? ''}:${message}`;
    if (lastReportMessage === dedupKey && now - lastReportAt < REPORT_DEDUP_MS) return;
    lastReportMessage = dedupKey;
    lastReportAt = now;

    const payload = {
      message,
      stack: error instanceof Error ? error.stack?.slice(0, 6000) : undefined,
      route: activityContext.route ?? undefined,
      sessionId: activityContext.sessionId ?? undefined,
    };
    try {
      void fetch('/api/activity/error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        keepalive: true,
        body: JSON.stringify(payload),
      }).catch(() => undefined);
    } catch {
      /* best-effort */
    }
  }

  private shouldSkipToast(error: unknown): boolean {
    // HttpError : geres par les services / interceptors avec un message contextuel.
    if (error instanceof HttpErrorResponse) return true;
    if (error && typeof error === 'object' && 'rejection' in error) {
      // Promise unhandled wrappee par Angular — unwrap pour analyser la cause.
      const rej = (error as { rejection: unknown }).rejection;
      if (rej instanceof HttpErrorResponse) return true;
      if (this.isAbortError(rej)) return true;
    }
    if (this.isAbortError(error)) return true;
    return false;
  }

  private isAbortError(e: unknown): boolean {
    return !!(e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'AbortError');
  }

  private describe(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    if (typeof error === 'string') return error;
    try { return JSON.stringify(error); } catch { return String(error); }
  }
}
