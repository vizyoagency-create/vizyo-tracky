import { motifDeRefus } from './user-drawer.component';

/**
 * INVITER UN DÉPÔT SANS FLOTTE PRODUIT UN COMPTE INERTE.
 *
 * Relevé le 2026-08-12 en préparant la recette dépôt de MH Cars. Le sélecteur de
 * flotte du drawer démarre sur « Aucune flotte », et rien ne l'imposait : ni
 * l'écran, ni l'API — `POST /users/invitations` accepte `fleetId: null` pour un
 * SUPER_ADMIN. L'invitation partait, le dépôt créait son mot de passe, son compte
 * existait.
 *
 * Et il ne servait à rien. `validerDepot` (missions.service) cherche le
 * destinataire par `{ id, fleetId, role: DEPOT }` : sans flotte, aucune mission ne
 * peut jamais lui être affectée. Le seul message visible arrivait bien plus tard,
 * dans l'agenda — « Le destinataire doit être un compte dépôt de votre flotte » —
 * sans rien qui ramène à l'écran d'invitation.
 *
 * D'où le refus AVANT l'envoi.
 */
describe('motifDeRefus', () => {
  const base = {
    mode: 'create' as const,
    email: 'depot@transporteur.fr',
    role: 'VIEWER',
    isSuperAdmin: true,
    fleetId: '',
  };

  it('laisse passer un formulaire complet', () => {
    expect(motifDeRefus({ ...base, role: 'DEPOT', fleetId: 'flotte-1' })).toBeNull();
  });

  it('refuse un dépôt sans flotte, en disant la conséquence', () => {
    const motif = motifDeRefus({ ...base, role: 'DEPOT' });
    expect(motif).toContain('flotte');
    expect(motif).toContain('aucune mission ne pourra lui être affectée');
  });

  it('n’exige la flotte que pour un dépôt — les autres rôles restent libres', () => {
    expect(motifDeRefus({ ...base, role: 'VIEWER' })).toBeNull();
    expect(motifDeRefus({ ...base, role: 'FLEET_MANAGER' })).toBeNull();
    expect(motifDeRefus({ ...base, role: 'DRIVER' })).toBeNull();
  });

  it('n’exige rien hors SUPER_ADMIN : le sélecteur n’est pas affiché, le serveur impose la flotte de l’inviteur', () => {
    expect(motifDeRefus({ ...base, role: 'DEPOT', isSuperAdmin: false })).toBeNull();
  });

  it('garde la règle de l’email, et la fait passer en premier', () => {
    expect(motifDeRefus({ ...base, email: '' })).toBe('Email requis');
    // Les deux manquent : l'email d'abord, c'est le champ du haut.
    expect(motifDeRefus({ ...base, email: '', role: 'DEPOT' })).toBe('Email requis');
  });

  it('ne réclame pas d’email hors création', () => {
    expect(motifDeRefus({ ...base, mode: 'edit', email: '' })).toBeNull();
    expect(motifDeRefus({ ...base, mode: 'edit-invitation', email: '' })).toBeNull();
  });

  it('exige aussi la flotte en modification d’invitation — même conséquence', () => {
    expect(motifDeRefus({ ...base, mode: 'edit-invitation', email: '', role: 'DEPOT' })).toContain(
      'flotte',
    );
  });
});
