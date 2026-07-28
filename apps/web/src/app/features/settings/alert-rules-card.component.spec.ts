import { serverMessage } from './alert-rules-card.component';

/**
 * Le message d'erreur du serveur doit ARRIVER À L'ÉCRAN.
 *
 * Cas réel (2026-07-28) : créer une règle depuis un compte super-admin échouait en
 * « 400 — fleetId requis ». L'écran affichait « Échec de l'enregistrement » et jetait le
 * motif. L'utilisateur a donc vu un échec opaque, impossible à diagnostiquer sans lire les
 * logs du serveur — alors que la réponse contenait exactement l'explication.
 *
 * Un échec muet est un échec qu'on ne corrige pas.
 */
describe('serverMessage', () => {
  it('rend le message d’une erreur Nest classique', () => {
    expect(serverMessage({ error: { message: 'fleetId requis' } })).toBe('fleetId requis');
  });

  it('joint les messages de validation (Nest en renvoie un tableau)', () => {
    expect(serverMessage({ error: { message: ['channels vide', 'alertType requis'] } }))
      .toBe('channels vide · alertType requis');
  });

  it('ignore les entrées non textuelles du tableau plutôt que d’afficher « [object Object] »', () => {
    expect(serverMessage({ error: { message: [{ a: 1 }, 'seul message utile'] } }))
      .toBe('seul message utile');
  });

  it('rend null quand il n’y a rien d’exploitable — l’appelant met alors son texte par défaut', () => {
    expect(serverMessage(undefined)).toBeNull();
    expect(serverMessage({})).toBeNull();
    expect(serverMessage({ error: {} })).toBeNull();
    expect(serverMessage({ error: { message: '' } })).toBeNull();
    expect(serverMessage({ error: { message: '   ' } })).toBeNull();
    expect(serverMessage({ error: { message: [] } })).toBeNull();
    expect(serverMessage({ error: { message: 42 } })).toBeNull();
  });

  it('nettoie les espaces superflus', () => {
    expect(serverMessage({ error: { message: '  fleetId requis  ' } })).toBe('fleetId requis');
  });
});
