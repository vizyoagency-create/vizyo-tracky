import { BANDES_VITESSE, CERCLAGE_PASTILLE_PX, COULEURS_CARTE } from './couleurs-carte';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEUX ROUGES — CE QUI LES DISTINGUE, ET POURQUOI CE N'EST PAS LA TEINTE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Question du propriétaire (section 8, point 5) : sur un rejeu, le tronçon 101-140 km/h et la
 * pastille d'un excès confirmé portent le MÊME rouge ; l'ambre 66-100 et la pointe à vérifier
 * le même ambre. Fallait-il changer une teinte ?
 *
 * Tranché à l'œil le 2026-09-08, sur banc, aux valeurs réelles et sur les deux fonds :
 *   · la rampe ne bouge pas — vert → ambre → rouge est la convention de lecture d'une vitesse ;
 *   · les DEUX bandes du milieu collisionnent, donc en repeindre une déplacerait le problème ;
 *   · une pastille cerclée de 2 px posée sur un tronçon de sa couleur se lit comme une bosse du
 *     trait ; à 3 px elle redevient un repère.
 *
 * Ce fichier verrouille les deux moitiés de cette décision : la collision est ASSUMÉE (et donc
 * documentée ici, pour que personne ne la « corrige » par accident), et le cerclage qui la rend
 * lisible ne peut plus être amaigri sans casser un test.
 */
describe('Pastilles de jugement posées sur un tracé de leur propre couleur', () => {
  const bande = (max: number) => BANDES_VITESSE.find((b) => b.max === max)!;

  it('la collision est un fait ASSUMÉ, pas un oubli : la bande 101-140 porte le rouge des excès', () => {
    expect(bande(140).couleur).toBe(COULEURS_CARTE.exces);
    expect(bande(100).couleur).toBe(COULEURS_CARTE.pointe);
  });

  it('🔴 le cerclage blanc gagne contre le trait du rejeu, qui fait 4 px', () => {
    expect(CERCLAGE_PASTILLE_PX).toBeGreaterThanOrEqual(3);
  });

  it("le contour reste blanc : c'est lui qui détache la pastille des quatre fonds de carte", () => {
    expect(COULEURS_CARTE.contour).toBe('#FFFFFF');
  });
});
