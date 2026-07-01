import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { activityContext } from '../services/activity-context';

/**
 * Interceptor de remontée d'erreurs HTTP au CENTRE D'ALERTE.
 *
 * Le GlobalErrorHandler ignore volontairement les HttpErrorResponse (gérées par
 * les services), et le backend ne journalise QUE les erreurs qu'il reçoit — donc
 * les pannes RÉSEAU / INFRA (requête qui n'atteint jamais l'API) sont totalement
 * INVISIBLES. C'est justement le symptôme d'un souci de connectivité (API down,
 * proxy, WS coupé). Cet interceptor comble le trou :
 *   - status 0   : réseau / CORS / timeout transport / API injoignable
 *   - 502 / 504  : passerelle (API down / trop lente) — pas journalisé côté app
 * On IGNORE les 4xx (attendus : validation, permissions, introuvable) et les 5xx
 * applicatifs (500/503 déjà journalisés par AllExceptionsFilter côté serveur).
 *
 * Best-effort + dédup (30s par méthode+URL+statut) pour ne pas inonder le centre
 * d'alerte. Ne reporte jamais les endpoints de reporting/temps-réel (anti-boucle),
 * et seulement si une session est active (l'endpoint /api/activity/error est gardé).
 */

const REPORTABLE = new Set([0, 502, 504]);
const DEDUP_MS = 30_000;
const EXCLUDED = ['/api/activity/', '/api/realtime/incident', '/api/observability/'];
const recent = new Map<string, number>();

export const errorReportInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    catchError((err: unknown) => {
      if (
        err instanceof HttpErrorResponse &&
        REPORTABLE.has(err.status) &&
        !EXCLUDED.some((p) => req.url.includes(p))
      ) {
        reportHttpError(req.method, req.url, err.status);
      }
      return throwError(() => err);
    }),
  );

function reportHttpError(method: string, rawUrl: string, status: number): void {
  if (!activityContext.sessionId) return; // endpoint gardé : rien à reporter sans session
  const url = stripQuery(rawUrl).slice(0, 300);
  const key = `${method} ${url} ${status}`;
  const now = Date.now();
  if (now - (recent.get(key) ?? 0) < DEDUP_MS) return;
  recent.set(key, now);
  if (recent.size > 100) {
    for (const [k, t] of recent) if (now - t > DEDUP_MS) recent.delete(k);
  }

  const label = status === 0 ? 'réseau / injoignable' : `passerelle ${status}`;
  const payload = {
    message: `Échec HTTP (${label}) : ${method} ${url}`,
    httpUrl: url,
    httpStatus: status,
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
    /* best-effort : si le réseau est down, ce report peut échouer aussi */
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i >= 0 ? url.slice(0, i) : url;
}
