import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { activityContext } from '../services/activity-context';
import { AuthService } from '../services/auth.service';
import { ConsentService } from '../services/consent.service';
import { SecurityService } from '../services/security.service';
import { RealtimeService } from '../services/realtime.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { getOrCreateDeviceId } from '../utils/device-id';

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

// #39 — N requetes 401 concurrentes ne doivent PAS executer N fois les effets de
// bord de deconnexion (disconnect/logout/navigate). Idempotent via un flag, reset
// apres 5s pour qu'une re-connexion + re-expiration ulterieure fonctionne.
let loggingOut = false;
function forceLogout(
  toast: ToastService,
  realtime: RealtimeService,
  auth: AuthService,
  router: Router,
): void {
  notifySessionExpired(toast);
  if (loggingOut) return;
  loggingOut = true;
  realtime.disconnect();
  auth.logout();
  void router.navigate(['/login']);
  setTimeout(() => { loggingOut = false; }, 5_000);
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const realtime = inject(RealtimeService);
  const toast = inject(ToastService);
  const consent = inject(ConsentService);
  const security = inject(SecurityService);

  // V1.10 (Sprint 6) — withCredentials: true active l'envoi des cookies
  // httpOnly tracky_at / tracky_rt poses au login. Le backend les lit en
  // priorite (cf. JwtAuthGuard). Le header Authorization reste injecte en
  // fallback pour la migration progressive : tant que le localStorage token
  // n'est pas retire (necessaire pour le WS handshake qui ne supporte pas
  // les cookies cross-origin de maniere fiable), les 2 modes cohabitent.
  req = req.clone({ withCredentials: true });

  // Sécurité — identifiant d'appareil (vérification e-mail des nouveaux appareils).
  // Même origine → pas de preflight CORS, coût nul. Le gate serveur lit cet entête
  // pour reconnaître un appareil de confiance.
  req = req.clone({ setHeaders: { 'X-Device-Id': getOrCreateDeviceId() } });

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
      // Gate RGPD : le back renvoie 403 { code:'CONSENT_REQUIRED' } tant que l'accord
      // n'est pas donné → on lève l'écran de consentement (backstop des appels HttpClient ;
      // le check boot /consent/current reste le gate primaire).
      if (
        error.status === 403 &&
        (error.error as { code?: string } | null)?.code === 'CONSENT_REQUIRED'
      ) {
        consent.require();
        return throwError(() => error);
      }

      // Sécurité : 403 { code:'DEVICE_VERIFICATION_REQUIRED' } tant que l'appareil
      // n'est pas vérifié → on lève l'écran de saisie du code (backstop ; le check
      // boot du statut reste le gate primaire).
      if (
        error.status === 403 &&
        (error.error as { code?: string } | null)?.code === 'DEVICE_VERIFICATION_REQUIRED'
      ) {
        security.require();
        return throwError(() => error);
      }

      if (error.status === 401 && auth.refreshToken) {
        // Tenter un refresh
        return from(auth.tryRefresh()).pipe(
          switchMap((newToken) => {
            if (newToken) {
              // Retry avec le nouveau token
              const retryReq = req.clone({ setHeaders: { Authorization: `Bearer ${newToken}` } });
              return next(retryReq);
            }
            // Refresh échoué → logout idempotent (avec toast informatif).
            forceLogout(toast, realtime, auth, router);
            return throwError(() => error);
          }),
        );
      }

      if (error.status === 401) {
        // Pas de refresh token → logout idempotent (avec toast informatif).
        forceLogout(toast, realtime, auth, router);
      }

      return throwError(() => error);
    }),
  );
};
