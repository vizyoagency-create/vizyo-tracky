import { messageDePanne } from './missions-panel.component';

/**
 * L'ONGLET MISSIONS ANNONÇAIT UNE FLOTTE VIDE POUR UNE PANNE.
 *
 * Relevé le 2026-08-12. L'échec du chargement était avalé : la liste restait vide
 * et l'écran affichait « Aucune mission créée pour l'instant » — la réponse métier
 * d'une flotte sans mission — pendant qu'un toast d'erreur surgissait par ailleurs.
 * Deux messages contradictoires, dont aucun n'indiquait quoi faire.
 *
 * Le cas qui l'a révélé : un SUPER_ADMIN a `fleetId = null`, et le serveur répond
 * « Aucune flotte associée ». Ce message-là est le seul utile — le repli dérivé du
 * statut 403 (« vous n'avez pas l'autorisation ») serait même FAUX, puisque le
 * compte a bien le droit et n'a qu'une société manquante.
 */
describe('messageDePanne', () => {
  it('préfère le message du serveur — c’est lui qui porte la cause', () => {
    expect(messageDePanne({ status: 403, error: { message: 'Aucune flotte associée' } })).toBe(
      'Aucune flotte associée',
    );
  });

  it('ne laisse jamais l’écran muet quand la réponse ne dit rien', () => {
    expect(messageDePanne({ status: 500 })).toContain('les missions');
    expect(messageDePanne({ status: 500, error: {} })).toContain('les missions');
    expect(messageDePanne({ status: 500, error: { message: '   ' } })).toContain('les missions');
  });

  it('distingue la session expirée de la panne serveur', () => {
    expect(messageDePanne({ status: 401 })).toContain('session');
    expect(messageDePanne({ status: 0 })).toContain('réseau');
  });

  it('ignore un message non textuel plutôt que d’afficher « [object Object] »', () => {
    const m = messageDePanne({ status: 400, error: { message: { code: 'X' } } });
    expect(m).not.toContain('object');
    expect(m).toContain('les missions');
  });

  it('résiste à une erreur nulle — traitée comme une requête qui n’a pas abouti', () => {
    // Pas de `status` lisible = 0 = le réseau n'a pas répondu, et c'est bien ce
    // qu'il faut dire : parler des missions supposerait que le serveur a parlé.
    expect(messageDePanne(null)).toContain('réseau');
    expect(messageDePanne(undefined)).toContain('réseau');
  });
});
