import { HttpErrorResponse, HttpHeaders, HttpRequest } from '@angular/common/http';
import { QUIET_ERRORS_HEADER, shouldAnnounce } from './auth.interceptor';

/**
 * ── Ce que ces tests VERROUILLENT (audit du 2026-08-03) ──────────────────────────────
 *
 * TROIS COUCHES se renvoyaient la responsabilité de signaler une panne HTTP :
 *
 *   1. `GlobalErrorHandler` ignore volontairement les `HttpErrorResponse`, en commentant
 *      « les interceptors HTTP les gèrent » ;
 *   2. les intercepteurs ne traitaient QUE le 401 ;
 *   3. les composants les attrapaient dans des `catch { /* handled *​/ }` — « handled »
 *      par personne.
 *
 * Résultat : hors session expirée, AUCUNE panne HTTP n'était jamais signalée. Le produit
 * savait parler quand tout allait bien (« Alerte acquittée ») et se taisait quand ça
 * cassait. L'utilisateur cliquait, rien ne se passait, aucun message.
 *
 * ⚠️ La règle testée ici est délibérément ÉTROITE. Annoncer tous les 4xx produirait du
 * bruit — un 400 ou un 409 porte un message métier que l'écran affiche déjà — et le bruit
 * finit ignoré. On n'annonce que ce que l'utilisateur ne peut pas deviner.
 */
describe('auth.interceptor — la panne doit se voir', () => {
  describe('ce qui doit être annoncé', () => {
    it('réseau coupé (0) — la requête n’a même pas abouti', () => {
      expect(shouldAnnounce(0)).toBeTrue();
    });

    it('403 — sans message, l’écran reste simplement vide et personne ne comprend', () => {
      expect(shouldAnnounce(403)).toBeTrue();
    });

    it('5xx — l’utilisateur n’y peut rien, mais doit savoir que ce n’est pas lui', () => {
      expect(shouldAnnounce(500)).toBeTrue();
      expect(shouldAnnounce(502)).toBeTrue();
      expect(shouldAnnounce(503)).toBeTrue();
    });
  });

  describe('ce qui ne doit PAS être annoncé', () => {
    it('401 — déjà traité en amont (déconnexion + son propre message)', () => {
      // Le redoubler afficherait DEUX toasts pour un seul événement.
      expect(shouldAnnounce(401)).toBeFalse();
    });

    it('4xx métier — le serveur envoie un message que l’écran affiche déjà', () => {
      for (const status of [400, 404, 409, 422]) {
        expect(shouldAnnounce(status))
          .withContext(
            `Le ${status} porte un message métier. Le doubler d'un toast générique ` +
              `ajouterait du bruit, et le bruit finit par être ignoré — y compris les ` +
              `messages qui comptent.`,
          )
          .toBeFalse();
      }
    });

    it('les succès ne déclenchent évidemment rien', () => {
      expect(shouldAnnounce(200)).toBeFalse();
      expect(shouldAnnounce(204)).toBeFalse();
      expect(shouldAnnounce(304)).toBeFalse();
    });
  });

  describe('opt-out des appels de fond', () => {
    it('l’en-tête existe et porte un nom transmissible en HTTP', () => {
      // Un en-tête HTTP ne peut pas contenir d'espace ni de caractère non-ASCII : une
      // faute ici ne casserait aucun type, mais la requête partirait sans l'en-tête et
      // le sondage redeviendrait bruyant.
      expect(QUIET_ERRORS_HEADER).toBe('X-Quiet-Errors');
      expect(QUIET_ERRORS_HEADER).toMatch(/^[A-Za-z0-9-]+$/);
    });

    it('une requête qui le porte est bien reconnue par has()', () => {
      // C'est exactement le test que fait l'intercepteur. Angular normalise la casse des
      // en-têtes : on vérifie que la détection ne dépend pas de la façon dont il est posé.
      const req = new HttpRequest('GET', '/api/vehicles/stats', {
        headers: new HttpHeaders({ [QUIET_ERRORS_HEADER]: '1' }),
      });
      expect(req.headers.has(QUIET_ERRORS_HEADER)).toBeTrue();
      expect(req.headers.has('x-quiet-errors')).toBeTrue();
    });

    it('une requête ordinaire ne le porte pas — le silence doit être un CHOIX explicite', () => {
      const req = new HttpRequest('GET', '/api/users');
      expect(req.headers.has(QUIET_ERRORS_HEADER)).toBeFalse();
    });
  });

  describe('les quatre familles de statut, prises ensemble', () => {
    it('décrit l’intention complète — une seule ligne à lire pour comprendre la règle', () => {
      const familles = {
        'réseau coupé (0)': shouldAnnounce(0),
        'session expirée (401)': shouldAnnounce(401),
        'permission refusée (403)': shouldAnnounce(403),
        'métier (404)': shouldAnnounce(404),
        'serveur (500)': shouldAnnounce(500),
      };
      expect(familles).toEqual({
        'réseau coupé (0)': true,
        'session expirée (401)': false,
        'permission refusée (403)': true,
        'métier (404)': false,
        'serveur (500)': true,
      });
    });

    it('un HttpErrorResponse réel expose bien le statut lu par le prédicat', () => {
      // Garde-fou de plomberie : si Angular changeait la forme de l'erreur, le prédicat
      // recevrait `undefined` et plus rien ne serait annoncé — en silence, forcément.
      const err = new HttpErrorResponse({ status: 503, statusText: 'Service Unavailable' });
      expect(typeof err.status).toBe('number');
      expect(shouldAnnounce(err.status)).toBeTrue();
    });
  });
});
