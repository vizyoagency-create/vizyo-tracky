import { apiFetch, apiFetchJson, apiFetchRaw } from './api-fetch';
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

  beforeEach(() => {
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
