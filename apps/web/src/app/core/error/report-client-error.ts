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
