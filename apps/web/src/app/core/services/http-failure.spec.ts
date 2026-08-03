import { HttpErrorResponse } from '@angular/common/http';
import { HttpFailure, httpFailureMessage, httpStatusOf } from './http-failure';

/**
 * ── Ce que ces tests VERROUILLENT (audit du 2026-08-03) ──────────────────────────────
 *
 * Deux écrans (Utilisateurs, Rapports) transformaient une panne en réponse métier
 * plausible : « Aucun utilisateur dans votre flotte », « Aucun trajet pour cette période ».
 * Une session expirée, un 403 et une panne serveur produisaient tous les trois le même
 * écran qu'une flotte réellement vide — donc personne ne signalait rien.
 *
 * La correction repose sur une seule chose : **le statut doit survivre au voyage**. S'il
 * se perd, l'écran ne peut plus rien distinguer, et le défaut revient tel quel.
 */
describe('http-failure', () => {
  describe('httpStatusOf — le statut survit aux deux mondes', () => {
    it('lit le statut d un HttpFailure (appels fetch natifs)', () => {
      expect(httpStatusOf(new HttpFailure(403, 'nope'))).toBe(403);
    });

    it('lit le statut d un HttpErrorResponse (appels HttpClient)', () => {
      // L'application mélange les deux : les Rapports passent par HttpClient, les
      // Utilisateurs par `fetch`. Un écran ne doit pas avoir à savoir lequel.
      expect(httpStatusOf(new HttpErrorResponse({ status: 401 }))).toBe(401);
    });

    it('retombe sur 0 pour une erreur quelconque, jamais sur undefined', () => {
      // 0 = « la requête n'a pas abouti ». Un `undefined` ici casserait les comparaisons
      // en aval et ferait retomber tout le monde sur le message générique par accident.
      expect(httpStatusOf(new Error('boom'))).toBe(0);
      expect(httpStatusOf(null)).toBe(0);
      expect(httpStatusOf(undefined)).toBe(0);
      expect(httpStatusOf({ status: 'oops' })).toBe(0);
    });
  });

  describe('httpFailureMessage — trois pannes, trois messages', () => {
    it('401 parle de session expirée et de reconnexion', () => {
      const msg = httpFailureMessage(new HttpFailure(401, ''), 'les utilisateurs');
      expect(msg).toContain('session');
      expect(msg).toContain('Reconnectez');
    });

    it('403 parle d autorisation, pas de session', () => {
      const msg = httpFailureMessage(new HttpFailure(403, ''), 'les utilisateurs');
      expect(msg).toContain('autorisation');
      expect(msg).not.toContain('Reconnectez');
    });

    it('500 invite à réessayer, sans accuser ni les droits ni la session', () => {
      const msg = httpFailureMessage(new HttpFailure(500, ''), 'les trajets');
      expect(msg).toContain('Réessayez');
      expect(msg).not.toContain('autorisation');
      expect(msg).not.toContain('session');
    });

    it('0 (réseau coupé) désigne le réseau, pas le serveur', () => {
      expect(httpFailureMessage(new Error('offline'), 'les trajets')).toContain('réseau');
    });

    it('les quatre situations donnent QUATRE messages distincts', () => {
      // ⚠️ Le cœur du défaut corrigé : quand deux pannes se ressemblent à l'écran, elles
      // se ressemblent aussi dans la tête de l'utilisateur — et il ne rappelle personne.
      const messages = [401, 403, 500, 0].map((s) =>
        httpFailureMessage(new HttpFailure(s, ''), 'les trajets'),
      );
      expect(new Set(messages).size).toBe(4);
    });

    it('aucun message ne ressemble à une réponse métier (« aucun », « vide »)', () => {
      // C'est exactement ce que faisaient les deux écrans avant correction.
      for (const status of [401, 403, 500, 0]) {
        const msg = httpFailureMessage(new HttpFailure(status, ''), 'les trajets').toLowerCase();
        expect(msg).not.toContain('aucun');
        expect(msg).not.toContain('vide');
      }
    });

    it('nomme le sujet demandé, pour que l écran dise DE QUOI il parle', () => {
      expect(httpFailureMessage(new HttpFailure(500, ''), 'les trajets')).toContain('les trajets');
      expect(httpFailureMessage(new HttpFailure(500, ''), 'les utilisateurs')).toContain(
        'les utilisateurs',
      );
    });
  });
});
