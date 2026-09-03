/**
 * L'analyse ne doit plus ériger en fait une vitesse que la trajectoire contredit.
 *
 * Cas réel, trajet EY-613-MF du 29 août 2026 (MH Cars) : le boîtier annonce 180 km/h alors que
 * le véhicule parcourt 727 mètres en vingt secondes, soit 131 km/h. Ce 180 s'affichait en rouge
 * sur la page Rapports, nourrissait le score de conduite et le rapport de vitesse — qui sert de
 * pièce disciplinaire — et n'apparaissait dans AUCUN excès, faute de limite résolue à cet endroit.
 * Deux chiffres contradictoires sur le même écran, dont un faux.
 *
 * On vérifie les deux moitiés de la règle : le point douteux ne fait plus la vitesse maximale et
 * ne peut plus fabriquer un excès, mais la pointe brute reste lisible et une conduite cohérente
 * n'est jamais amputée.
 */
import { analyzeTrip, type RawPosition } from './trip-analysis.preprocessor';

/** ~111 320 m par degré de latitude : fabrique une distance connue, plein nord. */
function nord(lat: number, metres: number): number {
  return lat + metres / 111_320;
}

function pos(lat: number, secondes: number, speedKmh: number): RawPosition {
  return {
    lat,
    lng: 1.24169,
    speedKmh,
    timestamp: new Date(Date.UTC(2026, 7, 29, 14, 22, secondes)),
    valid: true,
    ignition: true,
  } as RawPosition;
}

/** Séquence du 29 août : quatre points de 20 s, ~700 m chacun, avec un pic annoncé à 180. */
function sequenceDu29Aout(): RawPosition[] {
  let lat = 43.58223;
  const p1 = pos(lat, 18, 123);
  lat = nord(lat, 684);
  const p2 = pos(lat, 38, 126);
  lat = nord(lat, 727);
  const p3 = pos(lat, 58, 180); // ← contredit par la trajectoire : 727 m en 20 s = 131 km/h
  lat = nord(lat, 702);
  const p4 = { ...pos(lat, 58, 122), timestamp: new Date(Date.UTC(2026, 7, 29, 14, 23, 18)) };
  return [p1, p2, p3, p4];
}

describe('Analyse — vitesse non corroborée par la trajectoire', () => {
  it('ne retient pas 180 km/h comme vitesse maximale', () => {
    const r = analyzeTrip(sequenceDu29Aout());

    expect(r.maxSpeedKmh).toBeLessThan(180);
    expect(r.maxSpeedKmh).toBeGreaterThanOrEqual(122);
  });

  it('conserve la pointe brute et compte le point écarté — rien n’est effacé en silence', () => {
    const r = analyzeTrip(sequenceDu29Aout());

    expect(r.detail.vitesse?.pointeBruteKmh).toBe(180);
    expect(r.detail.vitesse?.pointsEcartes).toBe(1);
  });

  it('ne fabrique aucun excès à partir du point douteux, même avec une limite connue', () => {
    // Limite de 90 partout : sans le garde-fou, le point à 180 produirait un excès de +90.
    const r = analyzeTrip(sequenceDu29Aout(), {}, () => 90);

    const pics = r.detail.speeding.map((s) => s.maxSpeedKmh);
    expect(pics).not.toContain(180);
    // Les points réellement au-dessus de la limite, eux, restent comptés.
    expect(r.speedingCount).toBeGreaterThan(0);
    expect(r.maxOverKmh).toBeLessThan(90 - 90 + 60); // très en deçà des +90 qu'aurait donné le pic
  });

  it('ne touche pas à une conduite cohérente', () => {
    let lat = 43.6;
    const pts = [0, 1, 2, 3, 4].map((i) => {
      const p = pos(lat, i * 20, 90);
      lat = nord(lat, 500); // 500 m en 20 s = 90 km/h : le boîtier dit vrai
      return p;
    });

    const r = analyzeTrip(pts);

    expect(r.maxSpeedKmh).toBe(90);
    expect(r.detail.vitesse?.pointsEcartes).toBe(0);
  });

  it('ne juge pas quand les intervalles sont trop longs pour prouver quoi que ce soit', () => {
    // Deux points espacés de cinq minutes : la moyenne ne dit rien de la vitesse instantanée.
    const a = pos(43.6, 0, 40);
    const b = { ...pos(nord(43.6, 4000), 0, 190), timestamp: new Date(Date.UTC(2026, 7, 29, 14, 27, 0)) };

    const r = analyzeTrip([a, b]);

    expect(r.detail.vitesse?.pointsEcartes).toBe(0);
    expect(r.maxSpeedKmh).toBe(190);
  });
});
