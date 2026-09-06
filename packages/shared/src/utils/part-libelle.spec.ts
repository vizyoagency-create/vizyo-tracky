import { partLibelle } from './part-libelle';

/**
 * Ces cas ne sont pas des cas de bord : ce sont EXACTEMENT les chiffres de production du
 * 2026-09-05, là où l'arrondi naïf aurait menti sur un écran que le client lit tous les jours.
 */
describe('partLibelle — un arrondi qui ne contredit pas les nombres affichés à côté', () => {
  it('n’affirme pas « aucun » quand il y en a un : 1 sur 1 000 rend « < 1 % »', () => {
    // Le cas qui a motivé la règle. « 0 % » à côté de « 1 sur 1 000 » se lit comme une
    // contradiction, et c'est le pourcentage qui a tort.
    expect(partLibelle(1, 1000)).toBe('< 1 %');
  });

  it('n’affirme pas « tous » quand il en manque un : 999 sur 1 000 rend « > 99 % »', () => {
    expect(partLibelle(999, 1000)).toBe('> 99 %');
  });

  it('affirme les extrêmes quand ils sont VRAIS', () => {
    // 32 sur 32 chez Ahmed, mesuré le 2026-09-05 : là, « 100 % » est exact.
    expect(partLibelle(32, 32)).toBe('100 %');
    expect(partLibelle(0, 1886)).toBe('0 %');
  });

  it('rend le pourcentage ordinaire arrondi à l’entier', () => {
    // mh cars : 1 866 trajets non attribués sur 1 886. 98,9 % → « 99 % ».
    expect(partLibelle(1866, 1886)).toBe('99 %');
    // cdef31 : 2 675 sur 2 707.
    expect(partLibelle(2675, 2707)).toBe('99 %');
    expect(partLibelle(1, 2)).toBe('50 %');
  });

  it('ne divise jamais par zéro — une période sans trajet rend « 0 % », pas « NaN % »', () => {
    // Atteignable : une société qui démarre, ou un conducteur qui n'a pas roulé du mois.
    expect(partLibelle(0, 0)).toBe('0 %');
    expect(partLibelle(5, 0)).toBe('0 %');
  });

  it('traite un numérateur négatif comme zéro plutôt que de rendre un pourcentage négatif', () => {
    // Défense en profondeur : aucune donnée ne devrait l'être, mais « -3 % » dans un PDF
    // signé serait pire qu'un « 0 % » prudent.
    expect(partLibelle(-3, 100)).toBe('0 %');
  });
});
