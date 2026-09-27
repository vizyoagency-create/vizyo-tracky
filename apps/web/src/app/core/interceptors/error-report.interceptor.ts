import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, tap, throwError } from 'rxjs';
import { activityContext } from '../services/activity-context';
import { MiseAJourEnCoursService } from '../services/mise-a-jour-en-cours.service';

/**
 * Interceptor de remontée d'erreurs HTTP au CENTRE D'ALERTE.
 *
 * Le GlobalErrorHandler ignore volontairement les HttpErrorResponse (gérées par les services),
 * et le backend ne journalise QUE les erreurs qu'il reçoit — donc les pannes RÉSEAU / INFRA
 * (requête qui n'atteint jamais l'API : `status 0` réseau/CORS/timeout, `502`/`504` passerelle)
 * sont invisibles autrement. Cet interceptor comble ce trou. On IGNORE les 4xx (attendus) et les
 * 5xx applicatifs (déjà journalisés côté serveur par AllExceptionsFilter).
 *
 * ANTI-BRUIT (incident 2026-07-14) : un REDÉPLOIEMENT redémarre l'API ~15-45 s → l'app cliente voit
 * ses requêtes en vol échouer (status 0). Ce n'est PAS un incident. Avant, ça inondait le centre
 * d'alerte (1 entrée par endpoint en vol). Désormais on ne signale une API injoignable QUE si elle
 * PERSISTE au-delà de {@link OUTAGE_REPORT_MS}, et UNE SEULE FOIS par épisode. Toute réponse de
 * l'API (succès OU 4xx/5xx applicatif = l'API répond) clôt l'épisode.
 */

const REPORTABLE = new Set([0, 502, 504]);
const EXCLUDED = ['/api/activity/', '/api/realtime/incident', '/api/observability/'];
/** On ne signale une API injoignable que si ça dure au-delà de ce délai (couvre un déploiement api+web). */
const OUTAGE_REPORT_MS = 45_000;

let outageStart = 0; // timestamp du 1er échec de l'épisode courant (0 = aucun épisode en cours)
let outageReported = false; // épisode déjà signalé une fois ?

/** Une réponse de l'API est arrivée → elle est joignable → on clôt tout épisode d'injoignabilité. */
function endOutage(): void {
  outageStart = 0;
  outageReported = false;
}

export const errorReportInterceptor: HttpInterceptorFn = (req, next) => {
  // Incident CDEF31 du 24/09/2026 — le même signal sert deux usages qu'il ne faut pas confondre :
  // ce fichier SIGNALE au centre d'alerte (pour nous, après 45 s), le service ci-dessous PRÉVIENT
  // l'opérateur (pour lui, après 6 s) et recharge la page au retour de l'API. Deux délais, deux
  // publics : un exploitant n'a pas à attendre trois quarts de minute pour apprendre que l'écran
  // qu'il a sous les yeux ne vaut plus rien.
  const miseAJour = inject(MiseAJourEnCoursService);
  return next(req).pipe(
    tap((event) => {
      if (event instanceof HttpResponse) {
        endOutage();
        miseAJour.signalerReponseDeLApi();
      }
    }),
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && !EXCLUDED.some((p) => req.url.includes(p))) {
        if (REPORTABLE.has(err.status)) maybeReportOutage(req.method, req.url, err.status);
        else endOutage(); // 4xx / 5xx applicatif = l'API a RÉPONDU → elle est joignable.

        // L'écran, lui, réagit aussi au 503 : une passerelle qui rend « service indisponible »
        // pendant qu'un conteneur redémarre est exactement le cas à couvrir. Un 4xx/5xx
        // applicatif prouve au contraire que l'API vit — il clôt l'épisode.
        if (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504) {
          miseAJour.signalerEchecDeTransport(err.status);
        } else {
          miseAJour.signalerReponseDeLApi();
        }
      }
      return throwError(() => err);
    }),
  );
};

/** Ne signale qu'une injoignabilité DURABLE (> OUTAGE_REPORT_MS) et une seule fois par épisode. */
function maybeReportOutage(method: string, rawUrl: string, status: number): void {
  const now = Date.now();
  if (outageStart === 0) {
    outageStart = now; // 1er échec : on attend de voir si ça dure (probable déploiement sinon).
    return;
  }
  if (outageReported || now - outageStart < OUTAGE_REPORT_MS) return;
  outageReported = true;
  reportHttpError(method, rawUrl, status);
}

function reportHttpError(method: string, rawUrl: string, status: number): void {
  if (!activityContext.sessionId) return; // endpoint gardé : rien à reporter sans session
  // status 0 alors que le NAVIGATEUR se sait hors ligne = coupure réseau LOCALE (wifi tombé,
  // veille…), pas un incident backend → on ne le remonte pas.
  if (status === 0 && typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const url = stripQuery(rawUrl).slice(0, 300);
  const label = status === 0 ? 'réseau / injoignable' : `passerelle ${status}`;
  const payload = {
    message: `Échec HTTP (${label}) : ${method} ${url} — API injoignable depuis > 45 s`,
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
