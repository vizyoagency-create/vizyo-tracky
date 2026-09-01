import {
  libelleStatutCommande,
  tonStatutCommande,
} from './confirmation-commande';

/**
 * TRK-055 — le libellé et le TON d'un statut de commande, pour tout écran qui en affiche un.
 *
 * Constaté à l'écran le 01/09 en vérifiant TRK-051 : l'écran du mode fix affichait bien un badge
 * ambre, mais la fiche du tracker — et celle du véhicule, et l'écran d'administration — peignaient
 * `ACKNOWLEDGED` en VERT sous le mot « Confirmée », avec la colonne RÉPONSE vide à côté.
 * **394 commandes sur 7 jours, dont 0 avec réponse de boîtier.**
 */
describe('libellé et ton d un statut de commande (TRK-055)', () => {
  const mesuree = { status: 'ACKNOWLEDGED', ackResponse: null };
  const acquittee = { status: 'ACKNOWLEDGED', ackResponse: 'shock ok' };

  // 🔑 LE TEST QUI PORTE LA FICHE : le vert est RÉSERVÉ à une réponse matérielle.
  it('réserve le ton « succès » à une vraie réponse de boîtier', () => {
    expect(tonStatutCommande(acquittee)).toBe('succes');
    expect(tonStatutCommande(mesuree)).toBe('mesure');
    expect(tonStatutCommande(mesuree)).not.toBe('succes');
  });

  // ⚠️ Le mot lui-même affirmait une confirmation sans dire par quoi.
  it('n emploie plus jamais « Confirmée »', () => {
    for (const s of ['PENDING', 'SCHEDULED', 'SENT', 'ACKNOWLEDGED', 'FAILED', 'CANCELLED']) {
      expect(libelleStatutCommande({ status: s, ackResponse: null })).not.toMatch(/confirm/i);
    }
  });

  it('distingue les deux acquittements par le mot ET par le ton', () => {
    expect(libelleStatutCommande(acquittee)).toContain('boîtier');
    expect(libelleStatutCommande(mesuree)).toContain('mesurée');
    expect(libelleStatutCommande(acquittee)).not.toBe(libelleStatutCommande(mesuree));
  });

  // Une chaîne vide ne prouve rien : elle vaut absence de réponse.
  it('ne prend pas une réponse vide pour une preuve', () => {
    expect(tonStatutCommande({ status: 'ACKNOWLEDGED', ackResponse: '   ' })).toBe('mesure');
    expect(tonStatutCommande({ status: 'ACKNOWLEDGED', ackResponse: '' })).toBe('mesure');
  });

  it('laisse les autres statuts intacts', () => {
    expect(libelleStatutCommande({ status: 'FAILED', ackResponse: null })).toBe('Échouée');
    expect(tonStatutCommande({ status: 'FAILED', ackResponse: null })).toBe('echec');
    expect(libelleStatutCommande({ status: 'SENT', ackResponse: null })).toBe('Envoyée');
    expect(tonStatutCommande({ status: 'SCHEDULED', ackResponse: null })).toBe('planifie');
  });

  // ⚠️ `SENT` partageait le vert avec `ACKNOWLEDGED` : une commande partie, non confirmée,
  // s'affichait comme un succès. C'est la moitié silencieuse du même défaut.
  it('ne peint plus « envoyée » comme un succès', () => {
    expect(tonStatutCommande({ status: 'SENT', ackResponse: null })).toBe('attente');
  });
});
