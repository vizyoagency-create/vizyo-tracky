import { HttpErrorResponse } from '@angular/common/http';
import { codeErreur, corpsErreur } from './auth.interceptor';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE CODE MÉTIER D'UNE ERREUR, LU À TRAVERS L'ENVELOPPE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'API enveloppe ses erreurs : `{ error: { code, message, requestId } }`. Le code vit donc un
 * cran PLUS BAS que `HttpErrorResponse.error`, qui est déjà le corps analysé.
 *
 * Les deux gardes de sécurité lisaient `error.error.code` — c'est-à-dire un niveau trop haut —
 * et trouvaient donc toujours `undefined` :
 *
 *   · l'écran de CONSENTEMENT ne s'ouvrait jamais depuis un appel HttpClient ;
 *   · celui de VÉRIFICATION D'APPAREIL non plus.
 *
 * ⚠️ ET LE DÉFAUT ÉTAIT DOUBLÉ CÔTÉ SERVEUR, où le filtre d'exceptions écrasait le code par
 * `FORBIDDEN` avant même l'envoi. Deux erreurs qui se cachaient l'une l'autre : corriger une
 * seule des deux n'aurait rien changé au comportement observable — et aurait pu faire conclure
 * que la piste était mauvaise. C'est ce qui rend ce couple de tests nécessaire des DEUX côtés.
 *
 * Conséquence constatée le 2026-09-07 sur un compte DEPOT de production : l'espace dépôt, ne
 * pouvant plus distinguer ce 403 d'un retrait d'accès, affichait « Votre transporteur a fermé
 * cet accès ». On envoyait la personne appeler son transporteur pour un accord qu'elle seule
 * pouvait donner.
 */

/** Une erreur telle qu'Angular la livre : `error` est le corps DÉJÀ analysé. */
const erreur = (corps: unknown, status = 403): HttpErrorResponse =>
  new HttpErrorResponse({ status, error: corps });

describe('codeErreur — à travers l’enveloppe de l’API', () => {
  /**
   * 🔴 LE TEST DE RÉGRESSION. C'est exactement la forme que l'API envoie, et celle que
   * l'ancienne lecture ne voyait pas.
   */
  it('🔴 lit le code dans `{ error: { code } }`', () => {
    expect(codeErreur(erreur({ error: { code: 'CONSENT_REQUIRED', message: 'Consentement requis.', requestId: 187 } })))
      .toBe('CONSENT_REQUIRED');
  });

  it('la seconde garde aussi', () => {
    expect(codeErreur(erreur({ error: { code: 'DEVICE_VERIFICATION_REQUIRED' } })))
      .toBe('DEVICE_VERIFICATION_REQUIRED');
  });

  /**
   * ⚠️ LA FORME PLATE RESTE ACCEPTÉE. Une garde de sécurité ne doit pas dépendre d'un détail
   * de sérialisation : si une route échappait à l'enveloppe, le consentement continuerait de
   * fonctionner plutôt que d'échouer en silence.
   */
  it('la forme plate `{ code }` marche encore', () => {
    expect(codeErreur(erreur({ code: 'CONSENT_REQUIRED' }))).toBe('CONSENT_REQUIRED');
  });

  it('rien à lire : `null`, jamais une exception', () => {
    // Un corps vide, du texte brut, une coupure réseau — la lecture d'un code ne doit
    // jamais faire tomber l'intercepteur qui, lui, sert TOUTES les requêtes du produit.
    for (const corps of [null, undefined, '', 'Bad Gateway', 0, [], { autre: 1 }, { error: null }]) {
      expect(codeErreur(erreur(corps))).toBeNull();
    }
  });

  it('un 403 ordinaire n’a pas de code métier — et ne doit pas en inventer', () => {
    // Le témoin : si cette lecture rendait une chaîne pour n'importe quoi, l'écran de
    // consentement s'ouvrirait sur des refus de permission sans rapport.
    expect(codeErreur(erreur({ error: { code: 'FORBIDDEN', message: 'Accès refusé' } })))
      .toBe('FORBIDDEN');
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * CERTAINES ERREURS PORTENT LEUR MOTIF HORS DU `code`
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Un créneau déjà pris renvoie `MISSION_SLOT_CONFLICT` **avec** la plaque et la mission qui
 * bloque, dates comprises. Le dialogue d'agenda sait afficher « ce véhicule est pris de telle
 * à telle heure » — mais il lisait le corps À PLAT, donc ne trouvait ni le code ni les champs,
 * et retombait sur « La mission n'a pas pu être créée. » : un refus sans raison, devant lequel
 * la seule issue est de réessayer au hasard.
 */
describe('corpsErreur — le motif complet, pas seulement le code', () => {
  it('🔴 rend les champs métier de l’enveloppe', () => {
    const corps = corpsErreur(erreur({
      error: {
        code: 'MISSION_SLOT_CONFLICT',
        vehiclePlate: 'FM-772-JH',
        conflictingMission: { ref: 'M-241', startAt: '2026-09-08T08:00:00.000Z' },
        requestId: 412,
      },
    }, 409));

    expect(corps?.code).toBe('MISSION_SLOT_CONFLICT');
    expect(corps?.['vehiclePlate']).toBe('FM-772-JH');
    expect((corps?.['conflictingMission'] as { ref?: string }).ref).toBe('M-241');
  });

  it('la forme plate est rendue telle quelle', () => {
    expect(corpsErreur(erreur({ code: 'MISSION_SLOT_CONFLICT', vehiclePlate: 'AA-123-BB' }))?.['vehiclePlate'])
      .toBe('AA-123-BB');
  });

  it('rien de lisible : `null`, jamais une exception', () => {
    for (const c of [null, undefined, '', 'Bad Gateway', 0]) {
      expect(corpsErreur(erreur(c))).toBeNull();
    }
  });
});
