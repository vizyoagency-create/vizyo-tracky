/**
 * Taux de couverture des limites de vitesse, et rejeu des analyses incomplètes.
 *
 * Cas fondateur, mesuré en production le 3 septembre 2026 : sur le trajet EY-613-MF du 29 août,
 * un point à 131 km/h réels n'a produit AUCUN excès parce que la limite de sa cellule — 110 km/h —
 * est entrée en cache le 30 août à 06:30, soit le LENDEMAIN du trajet. La donnée existe depuis,
 * mais l'analyse n'était jamais rejouée : l'excès n'apparaîtrait jamais.
 *
 * `limitsKnown` ne pouvait pas servir à repérer ces analyses : c'est un booléen vrai dès qu'UN
 * SEUL point est résolu. Un trajet couvert à 2 % et un trajet couvert à 100 % lui répondaient
 * tous deux oui.
 */
import { analyzeTrip, SPEEDING_CANDIDATE_KMH, type RawPosition } from './trip-analysis.preprocessor';

/** ~111 320 m par degré de latitude. */
function nord(lat: number, metres: number): number {
  return lat + metres / 111_320;
}

/** Trajet cohérent : le déplacement colle à la vitesse, pour ne pas déclencher le garde-fou V1. */
function trajet(vitesses: number[]): RawPosition[] {
  let lat = 43.6;
  return vitesses.map((v, i) => {
    const p = {
      lat, lng: 1.4, speedKmh: v,
      timestamp: new Date(Date.UTC(2026, 7, 29, 14, 0, i * 20)),
      valid: true, ignition: true,
    } as RawPosition;
    lat = nord(lat, (v / 3.6) * 20);
    return p;
  });
}

describe('Taux de couverture des limites', () => {
  it('vaut 1 quand tous les points rapides ont obtenu une limite', () => {
    const r = analyzeTrip(trajet([80, 85, 90]), {}, () => 90);
    expect(r.limitsCoverage).toBe(1);
    expect(r.limitsKnown).toBe(true);
  });

  it('vaut zéro quand aucune limite n’a été trouvée, alors que des points la demandaient', () => {
    const r = analyzeTrip(trajet([80, 85, 90]), {}, () => null);
    expect(r.limitsCoverage).toBe(0);
    expect(r.limitsKnown).toBe(false);
  });

  it('distingue une couverture partielle, là où `limitsKnown` disait simplement « oui »', () => {
    // Un seul point sur quatre obtient une limite : l'ancien booléen valait déjà `true`.
    let appels = 0;
    const r = analyzeTrip(trajet([80, 85, 90, 95]), {}, () => (++appels === 1 ? 90 : null));

    expect(r.limitsKnown).toBe(true);
    expect(r.limitsCoverage).toBeCloseTo(0.25, 2);
  });

  it('ne compte que les points RAPIDES : un trajet lent ne rend aucun taux', () => {
    // Sous le seuil de candidature, aucune limite n'est demandée : un taux serait un artefact.
    const lent = SPEEDING_CANDIDATE_KMH - 10;
    const r = analyzeTrip(trajet([lent, lent, lent]), {}, () => null);

    expect(r.limitsCoverage).toBeNull();
  });

  it('rend `null` — et non zéro — quand aucun résolveur n’est fourni', () => {
    // Overpass indisponible : l'analyse tourne sans limites. Zéro laisserait croire qu'on a
    // cherché et rien trouvé, alors qu'on n'a pas cherché.
    const r = analyzeTrip(trajet([80, 85, 90]));
    expect(r.limitsCoverage).toBeNull();
  });

  it('reproduit le cas du 29 août : la limite arrive après coup, le taux le dit', () => {
    // Au moment de l'analyse, la cellule du point rapide n'est pas encore en cache.
    const avant = analyzeTrip(trajet([120, 125, 131]), {}, () => null);
    expect(avant.limitsCoverage).toBe(0);
    expect(avant.speedingCount).toBe(0);

    // Le lendemain, l'agent du poste a renseigné la cellule : le rejeu voit enfin l'excès.
    const apres = analyzeTrip(trajet([120, 125, 131]), {}, () => 110);
    expect(apres.limitsCoverage).toBe(1);
    expect(apres.speedingCount).toBeGreaterThan(0);
    expect(apres.maxOverKmh).toBeGreaterThan(15);
  });
});
