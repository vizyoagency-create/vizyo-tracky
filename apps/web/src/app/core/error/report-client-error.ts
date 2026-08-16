import { activityContext } from '../services/activity-context';

/**
 * Remonte une erreur CLIENT (bug JS attrapé) au CENTRE D'ALERTE admin → ErrorLogger → error_logs.
 * Best-effort : ne jette jamais, dédup 15s.
 *
 *  - CONNECTÉ (session présente) → `POST /api/activity/error` (authentifié, source `frontend`).
 *  - AVANT CONNEXION (pas de session : login / mot de passe oublié / reset) →
 *    `POST /api/public/client-error` (public throttlé, source `frontend-anon`). Sinon un bug
 *    pré-login serait une erreur FANTÔME — le pire cas pour la crédibilité
 *    (« je n'arrive pas à me connecter » = invisible côté admin).
 *
 * But : capturer « vraiment tous les bugs » (y compris ceux avalés dans un try/catch, que le
 * GlobalErrorHandler ne verrait pas) pour les corriger facilement depuis l'admin.
 */
let lastKey = '';
let lastAt = 0;
const DEDUP_MS = 15_000;

/**
 * Remet la dédup à zéro. **Réservé aux tests**, et ce n'est pas du confort.
 *
 * ⚠️ CES DEUX VARIABLES SONT UN SINGLETON DE MODULE, PARTAGÉ PAR TOUTE LA SUITE.
 * Karma charge les 353 tests dans UN seul contexte de navigateur, et Jasmine les joue
 * dans un ordre ALÉATOIRE. Deux tests qui déclenchent le même message se retrouvent
 * donc à moins de quinze secondes l'un de l'autre : le second est dédupliqué, son
 * `expect(...).toBe(1)` lit 0, et il échoue — mais seulement quand le tirage les met
 * dans cet ordre. Un défaut qui n'apparaît qu'une fois sur cinq, et jamais isolément.
 *
 * ⚠️ Ce n'est PAS ce qui rendait la suite instable pendant le lot A6 — celui-là venait
 * de `document.visibilityState`, cf. `api-fetch.spec`. Le piège décrit ici est réel,
 * simplement il n'avait pas encore mordu. Deux lignes de `beforeEach` le ferment avant.
 */
export function resetClientErrorDedup(): void {
  lastKey = '';
  lastAt = 0;
}

export function reportClientError(source: string, error: unknown, route?: string): void {
  try {
    const sessionId = activityContext.sessionId ?? null;
    const message = `[${source}] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(0, 2000);
    const now = Date.now();
    const key = `${sessionId ?? 'anon'}:${message}`;
    if (key === lastKey && now - lastAt < DEDUP_MS) return;
    lastKey = key;
    lastAt = now;
    const payload = {
      message,
      stack: error instanceof Error ? error.stack?.slice(0, 6000) : undefined,
      route: route ?? activityContext.route ?? undefined,
      sessionId: sessionId ?? undefined,
    };
    const authed = !!sessionId;
    void fetch(authed ? '/api/activity/error' : '/api/public/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // pré-login : endpoint public, aucun cookie à joindre
      credentials: authed ? 'include' : 'omit',
      keepalive: true,
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  } catch {
    /* la remontée d'erreur ne doit JAMAIS casser l'appelant */
  }
}
