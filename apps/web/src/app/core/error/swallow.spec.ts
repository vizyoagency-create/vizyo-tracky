import { HttpErrorResponse } from '@angular/common/http';
import { swallow } from './swallow';
import { HttpFailure } from '../services/http-failure';

/**
 * ── Ce que ces tests VERROUILLENT ────────────────────────────────────────────────────
 *
 * `swallow` décide de ce qui atterrit dans le centre d'alerte. Il peut donc échouer de
 * DEUX façons opposées, et les deux sont graves :
 *
 *   - trop peu → le bug reste invisible, c'est le problème qu'on répare ;
 *   - trop → le centre se remplit de fonctionnement normal (les 4xx, les erreurs déjà
 *     journalisées côté serveur), devient illisible, et on cesse de le consulter. Un
 *     centre d'alerte ignoré équivaut exactement à pas de centre du tout.
 *
 * D'où un périmètre étroit, vérifié dans les deux sens.
 */
describe('swallow — ce qui remonte au centre d’alerte', () => {
  let posted: string[];
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    posted = [];
    realFetch = globalThis.fetch;
    // On observe le POST réellement émis, pas un espion sur `reportClientError` : c'est
    // ce POST qui remplit le centre. Espionner l'intention laisserait passer une
    // remontée qui n'arrive jamais.
    spyOn(globalThis, 'fetch').and.callFake(((input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(String((init?.body as string) ?? String(input)));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof globalThis.fetch);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe('remonte', () => {
    it('une erreur JS — LE cas que rien d’autre ne voit', () => {
      // Ni « non rattrapée » (donc invisible au gestionnaire global), ni HTTP (donc
      // invisible aux intercepteurs et au serveur). Sans swallow, elle disparaît.
      swallow('agenda:chargement', new TypeError("Cannot read properties of undefined"));
      expect(posted.length).toBe(1);
      expect(posted[0]).toContain('agenda:chargement');
      expect(posted[0]).toContain('TypeError');
    });

    it('une valeur jetée qui n’est même pas une Error', () => {
      swallow('map:pins', 'boom');
      expect(posted.length).toBe(1);
    });

    it('nomme la SOURCE, pour retrouver le code sans deviner', () => {
      swallow('alerts:onAcknowledge', new Error('x'));
      expect(posted[0]).toContain('alerts:onAcknowledge');
    });
  });

  describe('ne remonte PAS — déjà couvert ailleurs', () => {
    it('une HttpErrorResponse 500 — le serveur l’a journalisée avec sa pile d’appels', () => {
      swallow('x:y', new HttpErrorResponse({ status: 500 }));
      expect(posted.length)
        .withContext(
          'La remonter ici créerait deux lignes pour un seul incident, dont la seconde ' +
            'serait la moins informative (pas de pile serveur).',
        )
        .toBe(0);
    });

    it('une HttpErrorResponse 404 — fonctionnement normal, pas un incident', () => {
      swallow('x:y', new HttpErrorResponse({ status: 404 }));
      expect(posted.length).toBe(0);
    });

    it('un HttpFailure — même monde HTTP, via les appels fetch', () => {
      // ⚠️ `HttpFailure` n'est PAS une `HttpErrorResponse` : le test par `instanceof`
      // seul le manquerait, et chaque panne réseau produirait un doublon.
      swallow('x:y', new HttpFailure(0, 'injoignable'));
      expect(posted.length).toBe(0);
    });

    it('toute erreur portant un statut numérique, quelle que soit sa classe', () => {
      swallow('x:y', { status: 503, message: 'indisponible' });
      expect(posted.length).toBe(0);
    });
  });

  describe('les deux mondes, côte à côte', () => {
    it('décrit la règle complète en une assertion', () => {
      const cas: Record<string, unknown> = {
        'erreur JS': new TypeError('boom'),
        'HTTP 500': new HttpErrorResponse({ status: 500 }),
        'HTTP 404': new HttpErrorResponse({ status: 404 }),
        'HttpFailure réseau': new HttpFailure(0, 'x'),
      };
      const remontees: Record<string, boolean> = {};
      for (const [nom, err] of Object.entries(cas)) {
        posted = [];
        swallow('t:t', err);
        remontees[nom] = posted.length > 0;
      }
      expect(remontees).toEqual({
        'erreur JS': true,
        'HTTP 500': false,
        'HTTP 404': false,
        'HttpFailure réseau': false,
      });
    });
  });
});
