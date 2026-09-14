import { activityContext } from '../services/activity-context';
import { estErreurDeTransport, reportClientError, resetClientErrorDedup } from './report-client-error';

/**
 * ── T59 / TRK-079 — ce qui remonte, et ce qui ne remonte plus ──────────────────────────────
 *
 * Deux façons d'échouer, opposées : trop (quatre lignes `frontend-anon` par robot qui ferme la
 * page — du bruit qui rend le centre illisible) et trop peu (un bug JS avant connexion qui ne
 * remonte plus — le pire cas pour la crédibilité). Les deux sens sont verrouillés ici.
 */
describe('reportClientError — appels avortés et canal anonyme (T59)', () => {
  let posted: Array<{ url: string; body: string }>;
  let realFetch: typeof globalThis.fetch;
  let visibilite: DocumentVisibilityState;

  beforeEach(() => {
    resetClientErrorDedup();
    activityContext.sessionId = null;
    activityContext.route = '/login';
    visibilite = 'visible';
    // Jamais le `visibilityState` RÉEL : il dépend du bureau, pas du code (cf. api-fetch.spec).
    spyOnProperty(document, 'visibilityState', 'get').and.callFake(() => visibilite);
    posted = [];
    realFetch = globalThis.fetch;
    spyOn(globalThis, 'fetch').and.callFake(((input: RequestInfo | URL, init?: RequestInit) => {
      posted.push({ url: String(input), body: String(init?.body ?? '') });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof globalThis.fetch);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    activityContext.sessionId = null;
    activityContext.route = null;
  });

  describe('canal anonyme (pas de session)', () => {
    it('🔴 le cas du 13/09 : un fetch avorté par la fermeture de la page NE remonte PAS', () => {
      reportClientError('demo-mode:health', new TypeError('Failed to fetch'));
      reportClientError('router:import', new TypeError('Failed to fetch dynamically imported module: https://x/chunk-ABC.js'));
      expect(posted.length).toBe(0);
    });

    it('les trois libellés des navigateurs sont des erreurs de transport', () => {
      expect(estErreurDeTransport(new TypeError('Failed to fetch'))).toBeTrue(); // Chrome
      expect(estErreurDeTransport(new TypeError('NetworkError when attempting to fetch resource.'))).toBeTrue(); // Firefox
      expect(estErreurDeTransport(new TypeError('Load failed'))).toBeTrue(); // Safari
      expect(estErreurDeTransport(new TypeError('Importing a module script failed.'))).toBeTrue(); // Safari, import différé
      expect(estErreurDeTransport(new TypeError('error loading dynamically imported module: https://x/y.js'))).toBeTrue(); // Firefox
    });

    it("🔴 un VRAI bug JS avant connexion remonte toujours, sur l'endpoint public", () => {
      reportClientError('login:submit', new TypeError("Cannot read properties of undefined (reading 'value')"));
      expect(posted.length).toBe(1);
      expect(posted[0].url).toBe('/api/public/client-error');
      expect(posted[0].body).toContain('login:submit');
    });

    it('une erreur qui n’est pas un TypeError remonte aussi (le motif seul ne suffit pas à la taire)', () => {
      reportClientError('reset:token', new Error('Failed to fetch'));
      expect(posted.length).toBe(1);
    });
  });

  describe('canal connecté (session présente)', () => {
    beforeEach(() => {
      activityContext.sessionId = 'sess-1';
      activityContext.route = '/map';
    });

    it('une panne de fetch page VISIBLE remonte (c’est peut-être une vraie panne)', () => {
      reportClientError('map:positions', new TypeError('Failed to fetch'));
      expect(posted.length).toBe(1);
      expect(posted[0].url).toBe('/api/activity/error');
    });

    it('la même panne page CACHÉE ne remonte pas — un onglet relégué annule ses requêtes', () => {
      visibilite = 'hidden';
      reportClientError('map:positions', new TypeError('Failed to fetch'));
      expect(posted.length).toBe(0);
    });

    it('après `pagehide`, plus aucune erreur de transport ne remonte ; `pageshow` (retour du bfcache) rouvre', () => {
      window.dispatchEvent(new Event('pagehide'));
      reportClientError('map:positions', new TypeError('Failed to fetch'));
      expect(posted.length).toBe(0);
      window.dispatchEvent(new Event('pageshow'));
      reportClientError('map:positions', new TypeError('Failed to fetch'));
      expect(posted.length).toBe(1);
    });

    it('un bug JS page cachée remonte quand même : la garde ne porte que sur le transport', () => {
      visibilite = 'hidden';
      reportClientError('agenda:render', new TypeError("Cannot read properties of null (reading 'id')"));
      expect(posted.length).toBe(1);
    });
  });
});
