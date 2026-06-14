import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { activityContext } from '../services/activity-context';
import { AuthService } from '../services/auth.service';
import { RealtimeService } from '../services/realtime.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

/**
 * V1.10 (Sprint 5 stabilite) — toast d'information lors d'un logout force
 * sur 401, pour eviter le syndrome "ca a redirige sans rien dire" qui faisait
 * remonter le bug par les clients. On dedup le toast via un flag module-level
 * (sinon plusieurs requetes 401 simultanees afficheraient N toasts).
 */
let sessionExpiredToastShown = false;
function notifySessionExpired(toast: ToastService): void {
  if (sessionExpiredToastShown) return;
  sessionExpiredToastShown = true;
  toast.error('Session expiree', 'Reconnectez-vous pour continuer.');
  // Reset apres 5s (au cas ou le user revient sans recharger, ex: redirection retardee).
  setTimeout(() => { sessionExpiredToastShown = false; }, 5_000);
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const realtime = inject(RealtimeService);
  const toast = inject(ToastService);

  // V1.10 (Sprint 6) — withCredentials: true active l'envoi des cookies
  // httpOnly tracky_at / tracky_rt poses au login. Le backend les lit en
  // priorite (cf. JwtAuthGuard). Le header Authorization reste injecte en
  // fallback pour la migration progressive : tant que le localStorage token
  // n'est pas retire (necessaire pour le WS handshake qui ne supporte pas
  // les cookies cross-origin de maniere fiable), les 2 modes cohabitent.
  req = req.clone({ withCredentials: true });

  // Contexte d'activité (page + session client) : attaché en headers pour que le
  // backend puisse relier une erreur serveur à « où » et « chez qui ». Même
  // origine -> pas de preflight CORS, coût nul.
  const ctxHeaders: Record<string, string> = {};
  if (activityContext.route) ctxHeaders['X-Current-Route'] = activityContext.route;
  if (activityContext.sessionId) ctxHeaders['X-Session-Id'] = activityContext.sessionId;
  if (Object.keys(ctxHeaders).length > 0) req = req.clone({ setHeaders: ctxHeaders });

  // Ne pas intercepter les requêtes auth (login, refresh)
  if (req.url.includes('/auth/login') || req.url.includes('/auth/refresh')) {
    const token = auth.token;
    if (token) {
      req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
    }
    return next(req);
  }

  // Ajouter le token
  const token = auth.token;
  if (token) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }

  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401 && auth.refreshToken) {
        // Tenter un refresh
        return from(auth.tryRefresh()).pipe(
          switchMap((newToken) => {
            if (newToken) {
              // Retry avec le nouveau token
              const retryReq = req.clone({ setHeaders: { Authorization: `Bearer ${newToken}` } });
              return next(retryReq);
            }
            // Refresh échoué → logout (avec toast informatif).
            notifySessionExpired(toast);
            realtime.disconnect();
            auth.logout();
            router.navigate(['/login']);
            return throwError(() => error);
          }),
        );
      }

      if (error.status === 401) {
        // Pas de refresh token → logout (avec toast informatif).
        notifySessionExpired(toast);
        realtime.disconnect();
        auth.logout();
        router.navigate(['/login']);
      }

      return throwError(() => error);
    }),
  );
};
