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
 * ── T59 / TRK-079 (2026-09-14) — UN APPEL AVORTÉ PAR LA FERMETURE DE LA PAGE N'EST PAS UN BUG ──
 *
 * Constat du 13/09 (22:50, 23:14) : deux robots (EC2, agent iPhone falsifié) chargent
 * l'application sans session et l'abandonnent au bout d'une seconde. Les requêtes en vol —
 * `fetch` de `/api/health` par le mode démo, import différé d'une route — sont annulées par la
 * navigation et rejettent `TypeError: Failed to fetch`, le même texte qu'une panne de réseau ;
 * et le rapport arrive quand même, parce qu'il part en `keepalive`. Quatre lignes `frontend-anon`
 * pour rien.
 *
 * Deux gardes, et deux seulement :
 *   1. une erreur de TRANSPORT (fetch / import de module) survenue page cachée ou après
 *      `pagehide` est un appel avorté par la navigation : on ne la remonte pas ;
 *   2. sur le canal ANONYME (pas de session), seules les erreurs qui ne sont pas de transport
 *      remontent — une vraie panne de `/api/health` vue par un anonyme relève de la sonde des
 *      dépendances, pas du centre d'alerte client.
 * Le canal public reste OUVERT : un bug JS avant connexion est le pire cas pour la crédibilité.
 */
let pageQuittee = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    pageQuittee = true;
  });
  // `pageshow` avec `persisted` : la page revient du bfcache, elle est de nouveau vivante.
  window.addEventListener('pageshow', () => {
    pageQuittee = false;
  });
}

/** Une panne de fetch, ou un import de module (route différée) qui n'a pas abouti. */
const MOTIF_TRANSPORT =
  /failed to fetch|networkerror|load failed|network request failed|dynamically imported module|importing a module script failed|error loading dynamically imported/i;

export function estErreurDeTransport(error: unknown): boolean {
  return error instanceof TypeError && MOTIF_TRANSPORT.test(error.message);
}

function pageEnTrainDeSeFermer(): boolean {
  if (pageQuittee) return true;
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

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
  pageQuittee = false;
}

export function reportClientError(source: string, error: unknown, route?: string): void {
  try {
    const sessionId = activityContext.sessionId ?? null;
    // T59 — les deux gardes, avant tout le reste (et avant la dédup : un silence ne consomme rien).
    if (estErreurDeTransport(error) && (pageEnTrainDeSeFermer() || !sessionId)) return;
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
