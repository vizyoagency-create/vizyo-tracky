import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage, motifErreurApi } from './api-error';

/**
 * ══ LE MOTIF D'UNE ERREUR D'API SE LIT DANS L'ENVELOPPE (relevé le 07/10/2026) ══════════════
 *
 * HttpClient range le corps de la réponse dans `err.error`, et l'API l'enveloppe toujours :
 * `{ error: { code, message, requestId } }` (`all-exceptions.filter.ts`, depuis le 13/04/2026).
 * 53 lectures du web cherchaient `err.error.message` — à plat — et trouvaient `undefined` : les
 * toasts disaient « Échec » sans dire pourquoi. Les erreurs ci-dessous ont la forme EXACTE de ce
 * que l'API sert ; aucune n'est fabriquée à plat sans le dire.
 */

/** Une erreur telle que HttpClient la remet, pour une réponse de l'API (corps enveloppé). */
const erreurApi = (status: number, enveloppe: Record<string, unknown>): HttpErrorResponse =>
  new HttpErrorResponse({ status, statusText: 'Erreur', url: '/api/x', error: { error: { requestId: 'r1', ...enveloppe } } });

describe('motifErreurApi — le motif, au bon niveau', () => {
  it('⚠️ lit le motif dans l’enveloppe que l’API sert vraiment', () => {
    expect(motifErreurApi(erreurApi(400, { code: 'BAD_REQUEST', message: 'Motif précis' }))).toBe('Motif précis');
  });

  it('garde le motif quand l’enveloppe porte des champs métier (code explicite)', () => {
    const conflit = erreurApi(409, { code: 'MISSION_SLOT_CONFLICT', message: 'Créneau déjà pris', vehiclePlate: 'AB-123-CD' });
    expect(motifErreurApi(conflit)).toBe('Créneau déjà pris');
  });

  it('lit la forme plate en repli, et joint une liste en ignorant ce qui n’est pas du texte', () => {
    expect(motifErreurApi({ error: { message: '  à plat  ' } })).toBe('à plat');
    expect(motifErreurApi({ error: { error: { message: ['date requise', 42, 'adresse requise'] } } })).toBe(
      'date requise · adresse requise',
    );
  });

  it('⚠️ un libellé de panne non maîtrisée n’est pas un motif', () => {
    expect(motifErreurApi(erreurApi(500, { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' }))).toBeUndefined();
    expect(motifErreurApi(erreurApi(500, { code: 'INTERNAL_SERVER_ERROR', message: 'Unknown error' }))).toBeUndefined();
    expect(motifErreurApi(erreurApi(500, { code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error' }))).toBeUndefined();
  });

  it('rien d’exploitable → undefined : corps vide, texte d’un proxy, motif vide ou non textuel', () => {
    expect(motifErreurApi(new HttpErrorResponse({ status: 502, error: '<html>Bad Gateway</html>' }))).toBeUndefined();
    expect(motifErreurApi(new HttpErrorResponse({ status: 0, error: null }))).toBeUndefined();
    expect(motifErreurApi(erreurApi(400, { code: 'BAD_REQUEST', message: '   ' }))).toBeUndefined();
    expect(motifErreurApi(erreurApi(400, { code: 'X', message: { detail: 'objet' } }))).toBeUndefined();
    expect(motifErreurApi(new TypeError('x is undefined'))).toBeUndefined();
    expect(motifErreurApi(null)).toBeUndefined();
    expect(motifErreurApi(undefined)).toBeUndefined();
  });
});

describe('apiErrorMessage — ce que l’écran affiche', () => {
  it('le motif du serveur quand il y en a un', () => {
    expect(apiErrorMessage(erreurApi(403, { code: 'FORBIDDEN', message: 'Véhicule hors de votre flotte' }), 'Repli')).toBe(
      'Véhicule hors de votre flotte',
    );
  });

  it('⚠️ le repli de l’écran sur une panne non maîtrisée — plus « Internal server error »', () => {
    expect(apiErrorMessage(erreurApi(500, { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' }), 'Enregistrement impossible.')).toBe(
      'Enregistrement impossible.',
    );
  });

  it('« serveur injoignable » quand la requête n’a pas abouti, le repli sinon', () => {
    expect(apiErrorMessage(new HttpErrorResponse({ status: 0, error: null }), 'Repli')).toBe(
      'Serveur injoignable. Vérifiez votre connexion.',
    );
    expect(apiErrorMessage(new HttpErrorResponse({ status: 404, error: null }), 'Repli')).toBe('Repli');
    expect(apiErrorMessage(new TypeError('x is undefined'), 'Repli')).toBe('Repli');
  });
});
