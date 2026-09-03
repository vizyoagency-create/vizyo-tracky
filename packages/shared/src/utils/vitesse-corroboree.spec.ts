/**
 * Corroboration d'une vitesse annoncée par le déplacement réellement observé.
 *
 * Le cas fondateur est réel : trajet EY-613-MF du 29 août 2026, société MH Cars. Le boîtier a
 * annoncé 180 km/h alors que le véhicule parcourait 727 mètres en vingt secondes, soit 131 km/h.
 * Le chiffre est parti en base, s'est affiché en rouge sur la page Rapports, a nourri le score de
 * conduite et le rapport de vitesse qui sert de pièce disciplinaire.
 *
 * Ces tests protègent les deux moitiés de la règle :
 *   1. on écarte ce que la trajectoire contredit ;
 *   2. on n'accuse JAMAIS sans preuve — une accélération franche, un intervalle trop long ou une
 *      position manquante laissent la donnée intacte. Un garde-fou qui efface des vitesses vraies
 *      serait pire que le défaut qu'il corrige.
 */
import {
  CORROBORATION_INTERVALLE_MAX_SEC,
  vitesseEstCorroboree,
  vitesseMaxCorroboree,
  vitesseObservee,
} from './gps-sanity';

/** Un point à `metres` au nord du précédent, `secondes` plus tard. */
function point(lat: number, lng: number, secondes: number, speedKmh: number) {
  return { lat, lng, speedKmh, timestamp: new Date(Date.UTC(2026, 7, 29, 14, 22, secondes)) };
}

/** ~111 320 m par degré de latitude : de quoi fabriquer une distance connue. */
function versLeNord(latDepart: number, metres: number): number {
  return latDepart + metres / 111_320;
}

describe('vitesseObservee', () => {
  it('rend la vitesse moyenne impliquée par le déplacement', () => {
    const a = point(43.58567, 1.26554, 18, 126);
    const b = point(versLeNord(43.58567, 727), 1.26554, 38, 180);
    // 727 m en 20 s = 130,86 km/h
    expect(vitesseObservee(a, b)).toBeCloseTo(130.9, 0);
  });

  it("s'abstient quand l'intervalle est trop long pour prouver quoi que ce soit", () => {
    // Cinq minutes : le véhicule a pu rouler vite puis se garer. La moyenne ne dit rien.
    const a = point(43.58567, 1.26554, 0, 0);
    const b = { lat: versLeNord(43.58567, 5000), lng: 1.26554, speedKmh: 130, timestamp: new Date(Date.UTC(2026, 7, 29, 14, 27, 0)) };
    expect(vitesseObservee(a, b)).toBeNull();
  });

  it("s'abstient sur un intervalle nul ou inversé, et sur une position hors bornes", () => {
    const a = point(43.58567, 1.26554, 18, 126);
    expect(vitesseObservee(a, point(43.58567, 1.26554, 18, 126))).toBeNull();
    expect(vitesseObservee(point(43.58567, 1.26554, 38, 126), a)).toBeNull();
    expect(vitesseObservee(a, { lat: 0, lng: 0, timestamp: new Date(Date.UTC(2026, 7, 29, 14, 22, 38)) })).toBeNull();
  });
});

describe('vitesseEstCorroboree', () => {
  it('écarte le pic à 180 km/h que la trajectoire contredit — le cas du 29 août', () => {
    // Intervalles voisins réels : 131 km/h avant, 126 km/h après.
    expect(vitesseEstCorroboree(180, [130.9, 126.4])).toBe(false);
  });

  it('accepte une accélération franche : la pointe dépasse toujours la moyenne', () => {
    // Le conducteur relance : la moyenne de l'intervalle reste sous la pointe atteinte à la fin.
    expect(vitesseEstCorroboree(130, [110, 128])).toBe(true);
  });

  it('accepte un freinage : la moyenne de l’intervalle suivant s’effondre', () => {
    expect(vitesseEstCorroboree(130, [122, 95])).toBe(true);
  });

  it('accepte une vitesse élevée mais soutenue par le déplacement', () => {
    expect(vitesseEstCorroboree(170, [165, 168])).toBe(true);
  });

  it("n'accuse pas sans preuve : aucun intervalle exploitable", () => {
    expect(vitesseEstCorroboree(180, [null, null])).toBe(true);
  });

  it('se contente du MEILLEUR intervalle : un seul voisin suffit à soutenir la valeur', () => {
    // Après le point, le signal est perdu ; l'intervalle d'avant suffit.
    expect(vitesseEstCorroboree(150, [140, null])).toBe(true);
  });

  it('laisse passer une vitesse nulle ou absurde sans la juger ici', () => {
    // Le zéro et le non-fini relèvent des autres garde-fous, pas de la corroboration.
    expect(vitesseEstCorroboree(0, [10])).toBe(true);
    expect(vitesseEstCorroboree(Number.NaN, [10])).toBe(true);
  });
});

describe('vitesseMaxCorroboree', () => {
  it('rend 131 et non 180 sur la séquence réelle, en gardant la pointe brute visible', () => {
    // Séquence reconstituée du 29 août : quatre points de 20 s, ~700 m chacun.
    let lat = 43.58223;
    const p1 = point(lat, 1.24169, 18, 123);
    lat = versLeNord(lat, 684);
    const p2 = point(lat, 1.24169, 38, 126);
    lat = versLeNord(lat, 727);
    const p3 = point(lat, 1.24169, 58, 180); // ← le pic contredit par la trajectoire
    lat = versLeNord(lat, 702);
    const p4 = { lat, lng: 1.24169, speedKmh: 122, timestamp: new Date(Date.UTC(2026, 7, 29, 14, 23, 18)) };

    const r = vitesseMaxCorroboree([p1, p2, p3, p4]);

    expect(r.pointeBruteKmh).toBe(180);
    expect(r.pointsEcartes).toBe(1);
    // La vitesse retenue est la plus haute que le déplacement soutient.
    expect(r.maxCorroboreeKmh).toBeLessThan(180);
    expect(r.maxCorroboreeKmh).toBeGreaterThanOrEqual(122);
  });

  it('ne retire rien à une séquence cohérente', () => {
    let lat = 43.6;
    const pts = [0, 1, 2, 3].map((i) => {
      const p = { lat, lng: 1.4, speedKmh: 90, timestamp: new Date(Date.UTC(2026, 7, 29, 14, 22, i * 20)) };
      lat = versLeNord(lat, 500); // 500 m en 20 s = 90 km/h
      return p;
    });

    const r = vitesseMaxCorroboree(pts);

    expect(r.pointsEcartes).toBe(0);
    expect(r.maxCorroboreeKmh).toBe(90);
    expect(r.pointeBruteKmh).toBe(90);
  });

  it('ne juge pas une séquence dont les intervalles dépassent la fenêtre de preuve', () => {
    const loin = CORROBORATION_INTERVALLE_MAX_SEC + 30;
    const pts = [
      { lat: 43.6, lng: 1.4, speedKmh: 40, timestamp: new Date(Date.UTC(2026, 7, 29, 14, 0, 0)) },
      { lat: 43.61, lng: 1.4, speedKmh: 190, timestamp: new Date(Date.UTC(2026, 7, 29, 14, 0, loin)) },
    ];

    const r = vitesseMaxCorroboree(pts);

    expect(r.pointsEcartes).toBe(0);
    expect(r.maxCorroboreeKmh).toBe(190);
  });

  it('rend zéro sur une liste vide, sans exception', () => {
    expect(vitesseMaxCorroboree([])).toEqual({ maxCorroboreeKmh: 0, pointeBruteKmh: 0, pointsEcartes: 0 });
  });
});
