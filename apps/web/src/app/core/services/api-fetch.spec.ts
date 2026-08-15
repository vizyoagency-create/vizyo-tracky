import { apiFetch, apiFetchJson, apiFetchRaw } from './api-fetch';
import { resetClientErrorDedup } from '../error/report-client-error';
import { HttpFailure } from './http-failure';

/**
 * ── Ce que ces tests VERROUILLENT (audit du 2026-08-03) ──────────────────────────────
 *
 * Trois services appellent l'API en `fetch` NATIF (25 appels). `fetch` ne traverse aucun
 * intercepteur Angular : ces appels échappaient donc aux DEUX mécanismes qui protègent
 * tous les autres — l'affichage de la panne, et sa remontée au centre d'alerte.
 *
 * Deux conséquences, toutes deux vérifiées ici :
 *
 *   1. le STATUT se perdait (`new Error('Failed to load users')`), donc l'écran ne pouvait
 *      pas distinguer une session expirée d'un refus de droit ou d'une panne serveur ;
 *   2. une API INJOIGNABLE sur ces appels n'apparaissait NULLE PART — le serveur n'ayant
 *      rien reçu, il ne pouvait rien journaliser.
 */
describe('api-fetch', () => {
  let realFetch: typeof globalThis.fetch;
  let reported: string[];
  /**
   * ⚠️ LA VISIBILITÉ EST ÉPINGLÉE, ET C'EST LE CORRECTIF DE L'INSTABILITÉ DE LA SUITE.
   *
   * `shouldReportNetworkFailure()` refuse de remonter quand la page est cachée — c'est
   * la raison d'être du module (cf. TRK-002 : un onglet en arrière-plan annule ses
   * requêtes, personne ne peut corriger ça). Les tests qui vérifient qu'une page
   * VISIBLE remonte bien lisaient donc `document.visibilityState` du navigateur RÉEL,
   * celui que Karma pilote.
   *
   * Or cette fenêtre passe en `hidden` dès qu'elle est reléguée à l'arrière-plan :
   * une autre application au premier plan, un écran qui s'éteint, une machine chargée.
   * Le test échouait alors sur `Expected 0 to be 1` — non parce que le code avait
   * changé, mais parce que personne ne regardait l'écran. D'où un échec « impossible à
   * reproduire » : il ne dépendait pas du code, il dépendait du bureau.
   *
   * On épingle donc l'état au lieu de le subir. Le test de la page cachée n'a plus
   * besoin d'un second espion : il pose la variable, et la restaure par le `beforeEach`
   * suivant.
   */
  let visibilite: DocumentVisibilityState;

  beforeEach(() => {
    visibilite = 'visible';
    spyOnProperty(document, 'visibilityState', 'get').and.callFake(() => visibilite);
    // `navigator.onLine` compte pour la même décision, et dépend de la machine.
    spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
    // La dédup de `reportClientError` est un SINGLETON DE MODULE, et Karma joue les 353
    // tests dans un seul contexte, dans un ordre tiré au sort. Deux tests qui produisent
    // le même message se retrouvent à moins de quinze secondes l'un de l'autre : le
    // second serait dédupliqué et lirait 0. Aucun couple ne se télescope depuis que la
    // visibilité est épinglée, mais l'état partagé, lui, doit être remis à zéro — sinon
    // le prochain test ajouté sans y penser rouvre exactement le même piège.
    resetClientErrorDedup();
    realFetch = globalThis.fetch;
    reported = [];
    // La remontée passe par `reportClientError`, qui poste sur /api/activity/error.
    // On l'observe par ce POST plutôt qu'en espionnant la fonction : c'est le
    // comportement OBSERVABLE, celui qui remplit réellement le centre d'alerte.
    spyOn(globalThis, 'fetch').and.callFake(((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/activity/error') || url.includes('/client-error')) {
        reported.push(String((init?.body as string) ?? ''));
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return pending(url, init);
    }) as typeof globalThis.fetch);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Remplacé par chaque test pour décider ce que répond l'API simulée. */
  let pending: (url: string, init?: RequestInit) => Promise<Response> = () =>
    Promise.resolve(new Response('{}', { status: 200 }));

  describe('le statut voyage avec l’erreur', () => {
    it('403 → HttpFailure portant 403, jamais un Error nu', async () => {
      pending = () => Promise.resolve(new Response('{}', { status: 403 }));
      await expectAsync(apiFetch('/api/users', undefined, 'Chargement')).toBeRejectedWith(
        jasmine.any(HttpFailure),
      );
      try {
        await apiFetch('/api/users', undefined, 'Chargement');
        fail('aurait dû jeter');
      } catch (err) {
        expect((err as HttpFailure).status).toBe(403);
      }
    });

    it('500 → statut conservé', async () => {
      pending = () => Promise.resolve(new Response('{}', { status: 500 }));
      try {
        await apiFetch('/api/users', undefined, 'Chargement');
        fail('aurait dû jeter');
      } catch (err) {
        expect((err as HttpFailure).status).toBe(500);
      }
    });

    it('réseau coupé → statut 0, la valeur qui signifie « n’a pas abouti »', async () => {
      pending = () => Promise.reject(new TypeError('Failed to fetch'));
      try {
        await apiFetch('/api/users', undefined, 'Chargement');
        fail('aurait dû jeter');
      } catch (err) {
        expect(err instanceof HttpFailure).toBeTrue();
        expect((err as HttpFailure).status).toBe(0);
      }
    });

    it('succès → la réponse est rendue telle quelle', async () => {
      pending = () => Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      const res = await apiFetch('/api/users', undefined, 'Chargement');
      expect(res.ok).toBeTrue();
    });
  });

  describe('remontée au centre d’alerte', () => {
    it('une API INJOIGNABLE est signalée — c’est le seul cas que personne d’autre ne voit', async () => {
      pending = () => Promise.reject(new TypeError('Failed to fetch'));
      await apiFetch('/api/users', undefined, 'Chargement des utilisateurs').catch(() => undefined);
      expect(reported.length)
        .withContext(
          'Le serveur n’a rien reçu, donc il n’a rien pu journaliser. Sans cette ' +
            'remontée côté client, l’incident n’existe nulle part.',
        )
        .toBe(1);
      expect(reported[0]).toContain('injoignable');
      expect(reported[0]).toContain('Chargement des utilisateurs');
    });

    it('un 4xx n’est PAS remonté — c’est une réponse attendue, pas un incident', async () => {
      pending = () => Promise.resolve(new Response('{}', { status: 403 }));
      await apiFetch('/api/users', undefined, 'Chargement').catch(() => undefined);
      expect(reported.length).toBe(0);
    });

    it('un 5xx n’est PAS remonté depuis le client — le serveur l’a déjà journalisé', async () => {
      // Le remonter aussi créerait DEUX lignes pour un seul incident, et la seconde
      // serait la moins informative des deux (pas de pile d'appels serveur).
      pending = () => Promise.resolve(new Response('{}', { status: 502 }));
      await apiFetch('/api/users', undefined, 'Chargement').catch(() => undefined);
      expect(reported.length).toBe(0);
    });

    // --- TRK-002 : la page cachée ---------------------------------------------------

    it('une page CACHÉE ne remonte pas — le navigateur tue les requêtes en vol', async () => {
      // Onglet en arrière-plan, appareil en veille, navigation en cours : le navigateur
      // annule les requêtes. Sur iOS c'est le fameux `TypeError: Load failed`. Ce n'est
      // pas une panne de plateforme, et personne ne peut le corriger.
      //
      // On DÉCLARE la page cachée — plus de second espion à poser puis à défaire : le
      // `beforeEach` remet `visibilite` à « visible » pour le test suivant.
      visibilite = 'hidden';
      pending = () => Promise.reject(new TypeError('Load failed'));
      await apiFetch('/api/users', undefined, 'Chargement').catch(() => undefined);
      expect(reported.length).toBe(0);
    });

    it('une page VISIBLE remonte toujours — sinon le module ne sert plus à rien', async () => {
      // 🔑 Le vrai test du correctif : il devait supprimer le bruit SANS supprimer le signal.
      //
      // ⚠️ C'est CE test qui rendait la suite instable, et il n'avait aucun défaut de
      // logique : il lisait la visibilité réelle de la fenêtre Karma. Quand elle passait
      // en arrière-plan, le module se taisait — exactement comme il doit le faire — et
      // l'assertion tombait. Voir la note sur `visibilite` en tête de fichier.
      pending = () => Promise.reject(new TypeError('Failed to fetch'));
      await apiFetch('/api/users', undefined, 'Chargement').catch(() => undefined);
      expect(reported.length).toBe(1);
    });

    it('apiFetchRaw en mode silencieux ne remonte pas (l’appelant va réessayer)', async () => {
      pending = () => Promise.reject(new TypeError('Load failed'));
      await apiFetchRaw('/api/auth/refresh', undefined, 'Rafraichissement de session', {
        silentNetworkFailure: true,
      }).catch(() => undefined);
      expect(reported.length).toBe(0);
    });

    it('deux pannes IDENTIQUES coup sur coup ne font qu’une ligne — la dédup existe vraiment', async () => {
      // Ce test verrouille le mécanisme qui rendait la suite instable, et il le fait
      // dans le bon sens : la dédup n'est pas un défaut, c'est le comportement voulu
      // (quinze secondes, cf. `reportClientError`). Sans elle, une API tombée
      // remplirait le centre d'alerte de cent lignes identiques en une minute.
      //
      // Ce qui était faux, c'est qu'un test en hérite d'un autre. La preuve tient en
      // deux appels : ici on la déclenche EXPRÈS, et une seule remontée part.
      pending = () => Promise.reject(new TypeError('Failed to fetch'));
      await apiFetch('/api/users', undefined, 'Chargement').catch(() => undefined);
      await apiFetch('/api/users', undefined, 'Chargement').catch(() => undefined);
      expect(reported.length)
        .withContext('la seconde panne identique doit être avalée par la dédup')
        .toBe(1);
    });

    it('apiFetchRaw sans mode silencieux remonte — c’est le second essai qui parle', async () => {
      pending = () => Promise.reject(new TypeError('Load failed'));
      await apiFetchRaw('/api/auth/refresh', undefined, 'Rafraichissement de session').catch(
        () => undefined,
      );
      expect(reported.length).toBe(1);
    });
  });

  describe('apiFetchJson — le message du serveur s’ajoute au statut, il ne le remplace pas', () => {
    it('garde le message métier ET le statut', async () => {
      pending = () =>
        Promise.resolve(
          new Response(JSON.stringify({ message: 'Cet e-mail est déjà utilisé' }), { status: 409 }),
        );
      try {
        await apiFetchJson('/api/users', { method: 'POST' }, 'Création');
        fail('aurait dû jeter');
      } catch (err) {
        const f = err as HttpFailure;
        // ⚠️ Les DEUX. Ne garder que le texte laisserait l'écran incapable de distinguer
        // une session expirée d'un refus de droit, donc de proposer la bonne action.
        expect(f.message).toBe('Cet e-mail est déjà utilisé');
        expect(f.status).toBe(409);
      }
    });

    it('retombe sur le libellé de l’appelant quand l’API ne dit rien', async () => {
      pending = () => Promise.resolve(new Response('nope', { status: 500 }));
      try {
        await apiFetchJson('/api/users', undefined, 'Création impossible');
        fail('aurait dû jeter');
      } catch (err) {
        expect((err as HttpFailure).message).toBe('Création impossible');
      }
    });

    it('rend le corps analysé en cas de succès', async () => {
      pending = () => Promise.resolve(new Response('{"id":"u1"}', { status: 200 }));
      const body = await apiFetchJson<{ id: string }>('/api/users', undefined, 'Création');
      expect(body.id).toBe('u1');
    });
  });

  describe('apiFetchRaw — rend la main sur TOUTE réponse', () => {
    it('ne jette pas sur un 409 : l’appelant doit pouvoir lire le corps', async () => {
      pending = () => Promise.resolve(new Response('{"message":"conflit"}', { status: 409 }));
      const res = await apiFetchRaw('/api/groups', undefined, 'Création');
      expect(res.status).toBe(409);
    });

    it('jette quand même sur une API injoignable, et la signale', async () => {
      pending = () => Promise.reject(new TypeError('Failed to fetch'));
      await expectAsync(apiFetchRaw('/api/groups', undefined, 'Création')).toBeRejectedWith(
        jasmine.any(HttpFailure),
      );
      expect(reported.length).toBe(1);
    });
  });
});
