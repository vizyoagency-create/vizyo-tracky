import { BANDES_VITESSE, couleurVitesse } from './couleurs-carte';
import { speedColor } from './maplibre-markers';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UNE SEULE ÉCHELLE DE VITESSE — et tout ce qui colore une vitesse y répond pareil
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Demande du propriétaire (2026-09-07) : 1–65 vert, 66–100 orange, 101–140 rouge, au-delà
 * rouge foncé. Les légendes sont générées depuis `BANDES_VITESSE` : la forme de la table est
 * donc un contrat d'affichage, pas un détail d'implémentation.
 */
describe('BANDES_VITESSE — la table que les légendes affichent', () => {
  it('compte cinq bandes, la première à 0 et la dernière sans plafond', () => {
    expect(BANDES_VITESSE.length).toBe(5);
    expect(BANDES_VITESSE[0].max).toBe(0);
    expect(BANDES_VITESSE[4].max).toBe(Number.POSITIVE_INFINITY);
  });

  it('a des plafonds strictement croissants — sinon « première bande qui couvre » ment', () => {
    for (let i = 1; i < BANDES_VITESSE.length; i++) {
      expect(BANDES_VITESSE[i].max).toBeGreaterThan(BANDES_VITESSE[i - 1].max);
    }
  });

  it('n’emploie jamais deux fois la même couleur ni le même libellé', () => {
    expect(new Set(BANDES_VITESSE.map((b) => b.couleur.toLowerCase())).size).toBe(5);
    expect(new Set(BANDES_VITESSE.map((b) => b.libelle)).size).toBe(5);
  });

  it('porte les seuils demandés : 65, 100, 140', () => {
    expect(BANDES_VITESSE.map((b) => b.max)).toEqual([0, 65, 100, 140, Number.POSITIVE_INFINITY]);
  });
});

describe('couleurVitesse — la première bande qui couvre la vitesse', () => {
  const [arret, vert, orange, rouge, fonce] = BANDES_VITESSE.map((b) => b.couleur);

  it('bornes incluses : 65 vert, 66 orange, 100 orange, 101 rouge, 140 rouge, 141 foncé', () => {
    expect(couleurVitesse(1)).toBe(vert);
    expect(couleurVitesse(65)).toBe(vert);
    expect(couleurVitesse(66)).toBe(orange);
    expect(couleurVitesse(100)).toBe(orange);
    expect(couleurVitesse(101)).toBe(rouge);
    expect(couleurVitesse(140)).toBe(rouge);
    expect(couleurVitesse(141)).toBe(fonce);
    expect(couleurVitesse(230)).toBe(fonce);
  });

  it('0, une vitesse négative ou absente : « à l’arrêt », jamais le rouge foncé', () => {
    expect(couleurVitesse(0)).toBe(arret);
    expect(couleurVitesse(-1)).toBe(arret);
    expect(couleurVitesse(Number.NaN)).toBe(arret);
    expect(couleurVitesse(undefined as unknown as number)).toBe(arret);
  });

  /**
   * Le marqueur (`speedColor`) et le segment de tracé (`couleurVitesse`) décrivent le même
   * véhicule au même instant : ils ne peuvent pas diverger d'un seul km/h.
   */
  it('speedColor répond exactement comme couleurVitesse, de 0 à 200 km/h', () => {
    for (let v = 0; v <= 200; v++) {
      expect(speedColor(v)).withContext(`${v} km/h`).toBe(couleurVitesse(v));
    }
  });
});
