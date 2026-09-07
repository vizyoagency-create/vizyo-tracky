import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { retourSur } from '../auth/retour-interne';
import { activityContext } from '../services/activity-context';
import { AuthService } from '../services/auth.service';
import { ConsentService } from '../services/consent.service';
import { SecurityService } from '../services/security.service';
import { RealtimeService } from '../services/realtime.service';
import { httpFailureMessage } from '../services/http-failure';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { getOrCreateDeviceId } from '../utils/device-id';
import { estPagePublique } from '../utils/page-publique';

/**
 * V1.10 (Sprint 5 stabilite) — toast d'information lors d'un logout force
 * sur 401, pour eviter le syndrome "ca a redirige sans rien dire" qui faisait
 * remonter le bug par les clients. On dedup le toast via un flag module-level
 * (sinon plusieurs requetes 401 simultanees afficheraient N toasts).
 */
let sessionExpiredToastShown = false;
/**
 * En-tête d'opt-out : une requête qui le porte ne déclenche aucun toast d'erreur.
 *
 * Réservé aux appels de FOND (sondage périodique, sonde de présence) : si l'API tombe,
 * un sondage toutes les 30 s produirait un toast toutes les 30 s. L'utilisateur
 * apprendrait à les ignorer — et n'y prêterait plus attention le jour où il en reçoit un
 * qui compte.
 *
 * ⚠️ À réserver aux appels que l'utilisateur n'a PAS déclenchés. Le poser sur une action
 * (un clic) recréerait exactement le silence corrigé ici.
 */
export const QUIET_ERRORS_HEADER = 'X-Quiet-Errors';

/**
 * Cette panne mérite-t-elle un message ?
 *
 * `0`   — la requête n'a pas abouti (réseau coupé, serveur injoignable).
 * `403` — refus de permission : sans message, l'écran reste simplement vide.
 * `5xx` — le serveur a échoué ; l'utilisateur n'y peut rien mais doit le savoir.
 *
 * Le 401 est traité plus haut (déconnexion + son propre message) ; le redoubler ici
 * afficherait deux toasts pour un seul événement.
 *
 * ⚠️ EXPORTÉ pour être testé DIRECTEMENT. Une première version du test recopiait ce
 * prédicat : il serait resté vert en cas de divergence, c'est-à-dire qu'il aurait garanti
 * sa propre copie et rien d'autre. Un test qui duplique ce qu'il vérifie ne vérifie rien.
 */
export function shouldAnnounce(status: number): boolean {
  return status === 0 || status === 403 || status >= 500;
}

function notifySessionExpired(toast: ToastService): void {
  if (sessionExpiredToastShown) return;
  sessionExpiredToastShown = true;
  toast.error('Session expirée', 'Reconnectez-vous pour continuer.');
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
  /**
   * ⚠️ ON GARDE L'ADRESSE OÙ L'ON ÉTAIT, comme le fait `authGuard` pour une entrée profonde.
   *
   * Ici la session expire pendant qu'on REGARDE quelque chose — un trajet ouvert depuis une
   * notification d'excès, un rapport sur une période choisie. Sans ce report, se reconnecter
   * renvoie au tableau de bord et il faut refaire le chemin de mémoire ; c'est le même défaut
   * que celui du garde, à l'autre bout de la vie d'une session.
   *
   * Ce qui mérite d'être reporté est défini par `retourSur`, partagé avec le garde de route
   * et avec la page de connexion qui suivra ce paramètre.
   */
  const retour = retourSur(router.url);
  void router.navigate(['/login'], retour ? { queryParams: { returnUrl: retour } } : {});
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
  //
  // ⚠️ SAUF SUR LA PAGE PUBLIQUE DE SUIVI (lot A4). `getOrCreateDeviceId()` ne fait pas
  // que lire : il ÉCRIT un identifiant stable dans le localStorage. Sur `/s/:token`,
  // cela poserait un identifiant persistant sur le téléphone d'un destinataire qui
  // n'a ni compte ni consentement — précisément le pistage qu'A4 § 6 interdit. Et il
  // ne sert à rien : la route publique n'a aucun gate d'appareil de confiance.
  if (!estPagePublique()) {
    req = req.clone({ setHeaders: { 'X-Device-Id': getOrCreateDeviceId() } });
  }

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
            // ⚠️ UN SERVEUR INJOIGNABLE NE DOIT PAS DÉCONNECTER.
            //
            // `tryRefresh()` rend `null` aussi bien pour un jeton refusé que pour une API
            // qui ne répond pas. Traiter les deux pareil éjectait tous les utilisateurs
            // connectés à CHAQUE redéploiement — constaté deux fois le 2026-08-03 — et au
            // moindre hoquet de réseau.
            //
            // Ici, on laisse simplement l'erreur remonter : la session reste en place, et
            // la requête suivante retentera un rafraîchissement une fois l'API revenue.
            if (auth.refreshUnavailable()) return throwError(() => error);

            // Refus réel (401/403 sur le refresh) → logout idempotent, avec son message.
            forceLogout(toast, realtime, auth, router);
            return throwError(() => error);
          }),
        );
      }

      if (error.status === 401) {
        // Pas de refresh token → logout idempotent (avec toast informatif).
        forceLogout(toast, realtime, auth, router);
      }

      // ══ LA PANNE DOIT SE VOIR ═══════════════════════════════════════════════════════
      //
      // ⚠️ AUDIT DU 2026-08-03 — TROIS COUCHES SE RENVOYAIENT LA RESPONSABILITÉ.
      //
      //   1. `GlobalErrorHandler` ignore volontairement les `HttpErrorResponse`, en
      //      commentant « les interceptors HTTP les gèrent ».
      //   2. Les intercepteurs ne traitaient QUE le 401.
      //   3. Les composants les attrapaient dans des `catch { /* handled */ }` —
      //      « handled » par personne.
      //
      // Conséquence : hors session expirée, AUCUNE panne HTTP n'était jamais signalée à
      // l'utilisateur. Serveur en erreur, réseau coupé, permission refusée : il cliquait,
      // rien ne se passait, aucun message. Le produit savait parler quand tout allait
      // bien (« Alerte acquittée ») et se taisait quand ça cassait.
      //
      // ⚠️ C'est ICI et nulle part ailleurs que la correction tient. Une erreur HTTP
      // attrapée par un `catch` n'atteint JAMAIS le gestionnaire global — mais elle
      // traverse toujours l'intercepteur. C'est la seule couche qui voit tout.
      //
      // Périmètre volontairement RESTREINT aux pannes que l'utilisateur ne peut pas
      // deviner. Les autres 4xx (400, 404, 409…) portent un message métier que l'écran
      // affiche déjà ; les doubler produirait du bruit, et le bruit finit ignoré.
      if (!req.headers.has(QUIET_ERRORS_HEADER) && shouldAnnounce(error.status)) {
        toast.error('Action impossible', httpFailureMessage(error, 'ces données'));
      }

      return throwError(() => error);
    }),
  );
};
