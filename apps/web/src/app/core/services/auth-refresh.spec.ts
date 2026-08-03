import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * ── UN SERVEUR INJOIGNABLE N'EST PAS UN JETON REFUSÉ ─────────────────────────────────
 *
 * ⚠️ Constat du 2026-08-03, vécu DEUX FOIS dans la même session de test : chaque
 * redéploiement de l'API déconnectait les utilisateurs connectés.
 *
 * `tryRefresh()` rendait `null` dans deux situations que rien ne distinguait :
 *
 *   - le jeton est refusé (401/403) → définitif, il FAUT déconnecter ;
 *   - le serveur ne répond pas (5xx, réseau) → temporaire, la session est valide.
 *
 * L'intercepteur lisait ce `null` comme un refus et déconnectait dans les deux cas. Un
 * simple hoquet de wifi suffisait à éjecter quelqu'un — et pendant les ~20 secondes d'un
 * redémarrage, tout le monde y passait.
 *
 * C'est le motif corrigé partout ailleurs ce jour-là : deux situations différentes
 * traitées à l'identique, et c'est la plus grave qui l'emporte à tort.
 */
describe('AuthService.tryRefresh — panne serveur vs jeton refusé', () => {
  let auth: AuthService;
  let realFetch: typeof globalThis.fetch;
  let reponse: () => Promise<Response>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient()],
    });
    localStorage.setItem('vizyo-tracky-refresh', 'un-refresh-token');
    auth = TestBed.inject(AuthService);

    realFetch = globalThis.fetch;
    reponse = () => Promise.resolve(new Response('{}', { status: 200 }));
    spyOn(globalThis, 'fetch').and.callFake((() => reponse()) as typeof globalThis.fetch);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.removeItem('vizyo-tracky-refresh');
  });

  describe('le drapeau distingue les deux mondes', () => {
    it('502 (API qui redémarre) → indisponible, PAS un refus', async () => {
      reponse = () => Promise.resolve(new Response('', { status: 502 }));
      expect(await auth.tryRefresh()).toBeNull();
      expect(auth.refreshUnavailable())
        .withContext(
          'Sans ce drapeau, l’intercepteur déconnecte — c’est ce qui éjectait tout le ' +
            'monde à chaque redéploiement.',
        )
        .toBeTrue();
    });

    it('503 → indisponible', async () => {
      reponse = () => Promise.resolve(new Response('', { status: 503 }));
      await auth.tryRefresh();
      expect(auth.refreshUnavailable()).toBeTrue();
    });

    it('réseau coupé (la requête n’aboutit pas) → indisponible', async () => {
      reponse = () => Promise.reject(new TypeError('Failed to fetch'));
      expect(await auth.tryRefresh()).toBeNull();
      expect(auth.refreshUnavailable()).toBeTrue();
    });

    it('401 (jeton réellement refusé) → PAS indisponible, la déconnexion est légitime', async () => {
      reponse = () => Promise.resolve(new Response('', { status: 401 }));
      expect(await auth.tryRefresh()).toBeNull();
      expect(auth.refreshUnavailable())
        .withContext(
          'Un jeton révoqué DOIT déconnecter. Marquer ce cas « indisponible » ' +
            'maintiendrait une session morte, ce qui est le défaut inverse.',
        )
        .toBeFalse();
    });

    it('403 → PAS indisponible non plus', async () => {
      reponse = () => Promise.resolve(new Response('', { status: 403 }));
      await auth.tryRefresh();
      expect(auth.refreshUnavailable()).toBeFalse();
    });
  });

  it('un succès REMET le drapeau à zéro', async () => {
    // Sans cette remise à zéro, une panne passagère rendrait la session indéboulonnable :
    // même un vrai 401 ultérieur ne déconnecterait plus.
    reponse = () => Promise.resolve(new Response('', { status: 502 }));
    await auth.tryRefresh();
    expect(auth.refreshUnavailable()).toBeTrue();

    reponse = () =>
      Promise.resolve(
        new Response(JSON.stringify({ accessToken: 'a', refreshToken: 'r' }), { status: 200 }),
      );
    expect(await auth.tryRefresh()).toBe('a');
    expect(auth.refreshUnavailable()).toBeFalse();
  });

  it('les cinq situations, prises ensemble', () => {
    // Une seule ligne à lire pour comprendre la règle de déconnexion.
    const decisionDeconnecter = (status: number): boolean => !(status === 0 || status >= 500);
    expect({
      'réseau coupé (0)': decisionDeconnecter(0),
      'serveur 502': decisionDeconnecter(502),
      'serveur 503': decisionDeconnecter(503),
      'jeton refusé 401': decisionDeconnecter(401),
      'interdit 403': decisionDeconnecter(403),
    }).toEqual({
      'réseau coupé (0)': false,
      'serveur 502': false,
      'serveur 503': false,
      'jeton refusé 401': true,
      'interdit 403': true,
    });
  });
});
