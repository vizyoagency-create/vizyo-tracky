import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { RealtimeService } from '../services/realtime.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const realtime = inject(RealtimeService);

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
            // Refresh échoué → logout
            realtime.disconnect();
            auth.logout();
            router.navigate(['/login']);
            return throwError(() => error);
          }),
        );
      }

      if (error.status === 401) {
        // Pas de refresh token → logout
        realtime.disconnect();
        auth.logout();
        router.navigate(['/login']);
      }

      return throwError(() => error);
    }),
  );
};
