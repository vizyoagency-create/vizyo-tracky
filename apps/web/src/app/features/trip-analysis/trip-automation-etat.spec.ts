import { etatPassage } from './trip-automation.component';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉTAT D'UN PASSAGE SE LIT D'UN COUP D'ŒIL — SURTOUT « INTERROMPU »
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * La ligne au départ (2026-09-08) fait apparaître dans l'historique des passages qui, avant,
 * n'existaient nulle part : ceux que l'API a emportés en redémarrant. L'écran doit les nommer,
 * et ne pas les faire passer pour « 0 analysé » — c'est exactement la lecture qui trompait.
 */
describe('Automatisation des trajets — état d\'un passage', () => {
  it('🔴 « interrompu » se voit, se nomme, et dit que la suite vient au passage suivant', () => {
    const e = etatPassage('interrupted');
    expect(e?.libelle).toBe('Interrompu');
    expect(e?.classe).toBe('interrompu');
    expect(e?.resume).toContain('jamais terminé');
    expect(e?.resume).toContain('passage suivant');
  });

  it('🔴 un passage interrompu sans trajet listé ne dit pas « rien de nouveau à traiter » (vu en production le 08/09)', () => {
    expect(etatPassage('interrupted')?.vide).toContain("n'est pas allé jusqu'au bout");
    expect(etatPassage('running')?.vide).toContain('en cours');
    expect(etatPassage('failed')?.vide).toContain('erreur');
  });

  it('« en cours » et « échec » ont chacun leur mot', () => {
    expect(etatPassage('running')?.libelle).toBe('En cours');
    expect(etatPassage('failed')?.libelle).toBe('Échec');
  });

  it('un passage clos n\'a rien à dire : sa ligne de chiffres parle', () => {
    expect(etatPassage('done')).toBeNull();
    expect(etatPassage(undefined)).toBeNull();
  });
});
