/**
 * La note de conduite doit pouvoir se défendre devant un client.
 *
 * ── CE QUE L'ANCIENNE FORMULE MESURAIT ──────────────────────────────────────────────────
 *     100 − à-coups×(100/km)×2 − NOMBRE d'excès×(100/km)×3 − minutes de ralenti×1,5
 * Ni la vitesse, ni la gravité d'un excès, ni sa durée. Constats de production du 3 septembre :
 *   · un trajet à 131 km/h de moyenne, pointe à 168, obtenait 96 sur 100 ;
 *   · un dépassement de +72 km/h coûtait exactement autant qu'un dépassement de +6 ;
 *   · la même conduite valait 69 sur 22 km et 96 sur 164 — vingt-sept points pour la distance ;
 *   · aucune conduite ne pouvait descendre sous 15 ;
 *   · une analyse sans la moindre position valait 100.
 *
 * Ces tests protègent la règle inverse : chaque point retiré s'énonce en une phrase, la vitesse
 * compte, et une note qu'on ne peut pas calculer n'est pas inventée.
 */
import { analyzeTrip, type RawPosition } from './trip-analysis.preprocessor';

/** ~111 320 m par degré de latitude. */
function nord(lat: number, metres: number): number {
  return lat + metres / 111_320;
}

/**
 * Trajet cohérent : le déplacement colle à la vitesse annoncée, pour ne pas déclencher le
 * garde-fou de corroboration du lot V1.
 */
function trajet(vitesses: number[], opts: { pasSec?: number } = {}): RawPosition[] {
  const pas = opts.pasSec ?? 20;
  let lat = 43.6;
  return vitesses.map((v, i) => {
    const p = {
      lat, lng: 1.4, speedKmh: v,
      timestamp: new Date(Date.UTC(2026, 7, 29, 14, 0, i * pas)),
      valid: true, ignition: true,
    } as RawPosition;
    lat = nord(lat, (v / 3.6) * pas);
    return p;
  });
}

describe('Note de conduite — la vitesse compte enfin', () => {
  it('sanctionne une pointe au-dessus de 130, sans consulter la moindre carte', () => {
    // Aucun résolveur : l'ancienne formule ne pouvait rien retirer, et rendait 100.
    const r = analyzeTrip(trajet([160, 165, 168, 160]));

    expect(r.ecoScore).not.toBeNull();
    expect(r.ecoScore!).toBeLessThan(85); // plus jamais un A
    const vitesse = r.detail.note?.penalites.find((p) => p.code === 'vitesse-absolue');
    expect(vitesse).toBeDefined();
    expect(vitesse!.phrase).toContain('aucune route française');
  });

  it('ne retire rien pour la vitesse quand le trajet reste sous 130', () => {
    const r = analyzeTrip(trajet([120, 125, 128, 122]), {}, () => 130);
    expect(r.detail.note?.penalites.some((p) => p.code === 'vitesse-absolue')).toBe(false);
  });

  it('distingue un dépassement de +6 d’un dépassement de +60', () => {
    const doux = analyzeTrip(trajet([95, 96, 95]), {}, () => 90);
    const grave = analyzeTrip(trajet([148, 150, 149]), {}, () => 90);

    const gravDoux = doux.detail.note?.penalites.find((p) => p.code === 'exces-gravite')?.points ?? 0;
    const gravGrave = grave.detail.note?.penalites.find((p) => p.code === 'exces-gravite')?.points ?? 0;
    expect(gravGrave).toBeGreaterThan(gravDoux);
    expect(grave.ecoScore!).toBeLessThan(doux.ecoScore!);
  });

  it('compte le TEMPS passé en excès, pas le nombre de segments', () => {
    // Même conduite, mais l'excès dure plus longtemps : la note doit baisser davantage.
    const court = analyzeTrip(trajet([100, 100, 60, 60, 60, 60]), {}, () => 90);
    const long = analyzeTrip(trajet([100, 100, 100, 100, 100, 60]), {}, () => 90);

    const partCourt = court.detail.note?.penalites.find((p) => p.code === 'exces-duree')?.points ?? 0;
    const partLong = long.detail.note?.penalites.find((p) => p.code === 'exces-duree')?.points ?? 0;
    expect(partLong).toBeGreaterThan(partCourt);
  });

  it('chaque pénalité porte une phrase lisible, sans jargon ni code', () => {
    const r = analyzeTrip(trajet([150, 152, 150]), {}, () => 90);
    for (const p of r.detail.note?.penalites ?? []) {
      expect(p.phrase.length).toBeGreaterThan(10);
      expect(p.points).toBeGreaterThan(0);
      expect(p.phrase).not.toMatch(/ecoScore|per100|penalite/i);
    }
  });
});

describe('Note de conduite — ne pas décerner un A par ignorance', () => {
  it('plafonne la note quand presque aucune limite n’a été retrouvée', () => {
    // Un seul point sur quatre obtient une limite : la note ne repose sur presque rien.
    let appels = 0;
    const r = analyzeTrip(trajet([80, 82, 84, 86]), {}, () => (++appels === 1 ? 90 : null));

    expect(r.limitsCoverage).toBeLessThan(0.5);
    expect(r.ecoScore!).toBeLessThanOrEqual(69);
    expect(r.detail.note?.plafond?.raison).toContain('plafonnée');
  });

  it('ne plafonne pas un trajet lent, pour lequel aucune limite n’était nécessaire', () => {
    const r = analyzeTrip(trajet([20, 22, 21]));
    expect(r.detail.note?.plafond).toBeUndefined();
  });

  it('ne plafonne pas quand la couverture est bonne', () => {
    const r = analyzeTrip(trajet([80, 82, 84]), {}, () => 90);
    expect(r.limitsCoverage).toBe(1);
    expect(r.detail.note?.plafond).toBeUndefined();
  });
});

describe('Note de conduite — une note absente n’est pas une note parfaite', () => {
  it('rend `null` sur une analyse sans aucune position exploitable', () => {
    const r = analyzeTrip([]);
    expect(r.ecoScore).toBeNull();
    expect(r.gpsPoints).toBe(0);
  });
});

describe('Note de conduite — la distance ne fait plus la note', () => {
  it('ne creuse plus vingt-sept points entre deux trajets de conduite identique', () => {
    // Même part de temps en excès, même gravité, même absence d'à-coups : seule la distance
    // change (pas de 20 s contre pas de 20 s sur deux fois plus de points).
    const court = analyzeTrip(trajet([100, 100, 100, 60]), {}, () => 90);
    const long = analyzeTrip(trajet([100, 100, 100, 100, 100, 100, 60, 60]), {}, () => 90);

    expect(court.ecoScore).not.toBeNull();
    expect(long.ecoScore).not.toBeNull();
    // Un écart résiduel est normal (la part de temps en excès diffère un peu) ; l'ordre de
    // grandeur de l'ancien défaut — 27 points — ne doit plus se produire.
    expect(Math.abs(court.ecoScore! - long.ecoScore!)).toBeLessThan(15);
  });

  it('sanctionne vraiment une conduite fautive, là où l’ancienne formule rendait 97', () => {
    // Tout le trajet à 170-175 km/h sur une voie à 90. L'ancienne formule ne voyait qu'UN
    // segment d'excès : 100 − min(35, 1 × per100 × 3) ≈ 97 sur 100, soit un A.
    const r = analyzeTrip(trajet([170, 172, 175, 173, 171, 170]), {}, () => 90);

    // Désormais : 30 points pour le temps passé en excès, 15 pour la gravité, 25 pour la
    // pointe au-dessus de 130 — la note tombe dans la dernière tranche.
    expect(r.ecoScore!).toBeLessThan(40);
    const codes = (r.detail.note?.penalites ?? []).map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['exces-duree', 'exces-gravite', 'vitesse-absolue']));
  });
});
