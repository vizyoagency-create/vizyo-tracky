/**
 * La règle d'imputation vit à UN seul endroit — c'est tout l'objet de ce fichier.
 *
 * Deux écrans la posent : le classement des notes (portée « conducteur ou groupe ») et le
 * récapitulatif de la page Rapports (F13). Tant qu'ils appellent cette fonction, ils ne
 * peuvent pas répondre différemment à « combien a roulé ce conducteur ce mois-ci ? ».
 */
import { CLE_NON_ATTRIBUE, cleImputationTrajet, sorteImputation } from './imputation-trajet';

describe('Imputation d’un trajet — conducteur, sinon groupe, sinon personne', () => {
  it('le conducteur PRIME sur le groupe : un véhicule groupé ET conduit compte pour son conducteur', () => {
    // Sans cette priorité, les kilomètres d'un conducteur connu tomberaient dans le total de
    // son groupe, et le classement « qui conduit comment ? » serait muet là où il a une réponse.
    expect(cleImputationTrajet('d1', 'g1')).toBe('driver:d1');
    expect(cleImputationTrajet('d1', null)).toBe('driver:d1');
  });

  it('sans conducteur, le groupe du véhicule prend le relais', () => {
    // Mesuré le 2026-09-05 : 2 675 trajets sur 2 707 chez cdef31 sont dans ce cas. Sans le
    // repli, 99 % du parc serait « non attribué » et l'écran ne dirait rien de personne.
    expect(cleImputationTrajet(null, 'g1')).toBe('group:g1');
  });

  it('ni l’un ni l’autre : la clé « non attribué », qui est comptée mais jamais classée', () => {
    expect(cleImputationTrajet(null, null)).toBe(CLE_NON_ATTRIBUE);
    expect(cleImputationTrajet(undefined, undefined)).toBe(CLE_NON_ATTRIBUE);
    // Une chaîne vide n'est pas un identifiant : elle ne doit pas fabriquer « driver: ».
    expect(cleImputationTrajet('', '')).toBe(CLE_NON_ATTRIBUE);
  });

  it('la sorte se relit sur la clé — l’écran n’a pas à la deviner', () => {
    expect(sorteImputation(cleImputationTrajet('d1', 'g1'))).toBe('driver');
    expect(sorteImputation(cleImputationTrajet(null, 'g1'))).toBe('group');
    expect(sorteImputation(CLE_NON_ATTRIBUE)).toBe('non-attribue');
  });

  it('⚠️ un identifiant qui contiendrait le préfixe de l’autre ne trompe pas la lecture', () => {
    // Les identifiants sont des UUID ; la garde protège d'un futur identifiant plus libre.
    expect(sorteImputation('driver:group:x')).toBe('driver');
    expect(sorteImputation('group:driver:x')).toBe('group');
  });
});
