import { activityContext } from '../services/activity-context';

/**
 * Remonte une erreur CLIENT (bug JS attrapé) au CENTRE D'ALERTE admin — source
 * `frontend` via `POST /api/activity/error` → ErrorLogger → error_logs. Best-effort :
 * ne jette jamais, dédup 15s, ignoré si aucune session (endpoint gardé).
 *
 * But : capturer « vraiment tous les bugs » (y compris ceux avalés dans un try/catch,
 * que le GlobalErrorHandler ne verrait pas) pour les corriger facilement depuis l'admin.
 */
let lastKey = '';
let lastAt = 0;
const DEDUP_MS = 15_000;

export function reportClientError(source: string, error: unknown, route?: string): void {
  try {
    if (!activityContext.sessionId) return;
    const message = `[${source}] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(0, 2000);
    const now = Date.now();
    const key = `${activityContext.sessionId}:${message}`;
    if (key === lastKey && now - lastAt < DEDUP_MS) return;
    lastKey = key;
    lastAt = now;
    const payload = {
      message,
      stack: error instanceof Error ? error.stack?.slice(0, 6000) : undefined,
      route: route ?? activityContext.route ?? undefined,
      sessionId: activityContext.sessionId ?? undefined,
    };
    void fetch('/api/activity/error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      keepalive: true,
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  } catch {
    /* la remontée d'erreur ne doit JAMAIS casser l'appelant */
  }
}
