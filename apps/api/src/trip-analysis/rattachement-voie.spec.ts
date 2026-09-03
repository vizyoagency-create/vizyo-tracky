/**
 * Rattachement d'un point GPS à la bonne voie, et refus d'affirmer un excès douteux.
 *
 * Cas fondateur, relevé le 3 septembre 2026 sur la rocade toulousaine : un véhicule à 102 km/h
 * s'est vu attribuer une limite de 30 km/h, soit « +72 km/h » présenté comme un excès confirmé.
 * Le conducteur roulait sur la rocade ; la voie à 30 est un PONT qui la franchit, projeté au même
 * endroit en deux dimensions. La sélection ne regardait que la distance.
 *
 * Deux garde-fous, testés séparément :
 *   1. à la SOURCE — une voie hors du niveau du sol, ou une voie de desserte, est le choix le
 *      moins probable à distance comparable ;
 *   2. en AVAL — un dépassement énorme sur une voie lente n'est pas affirmé, quoi qu'ait dit la
 *      carte, car aucune donnée cartographique n'est parfaite.
 *
 * Et la contrepartie, tout aussi importante : un pont réellement emprunté reste choisi, et une
 * conduite fautive reste comptée.
 */
import { analyzeTrip, type RawPosition } from './trip-analysis.preprocessor';
import { estHorsNiveauSol, malusVoie, voieLaPlusProche } from './speed-limit.resolution';

/** Une voie OSM rectiligne est-ouest, à la latitude donnée. */
function voie(lat: number, tags: Record<string, string>) {
  return {
    type: 'way' as const,
    id: Math.round(lat * 1e6),
    tags,
    geometry: [
      { lat, lon: 1.3850 },
      { lat, lon: 1.3860 },
    ],
  };
}

/** ~111 320 m par degré de latitude. */
function nord(lat: number, metres: number): number {
  return lat + metres / 111_320;
}

describe('estHorsNiveauSol', () => {
  it('reconnaît un pont, un tunnel et une couche non nulle', () => {
    expect(estHorsNiveauSol({ bridge: 'yes' })).toBe(true);
    expect(estHorsNiveauSol({ tunnel: 'yes' })).toBe(true);
    expect(estHorsNiveauSol({ layer: '1' })).toBe(true);
    expect(estHorsNiveauSol({ layer: '-1' })).toBe(true);
  });

  it('ne se laisse pas prendre par les valeurs négatives explicites ni par le niveau zéro', () => {
    expect(estHorsNiveauSol({ bridge: 'no' })).toBe(false);
    expect(estHorsNiveauSol({ tunnel: 'no' })).toBe(false);
    expect(estHorsNiveauSol({ layer: '0' })).toBe(false);
    expect(estHorsNiveauSol({})).toBe(false);
    expect(estHorsNiveauSol(undefined)).toBe(false);
  });
});

describe('malusVoie', () => {
  it('pénalise le hors-sol, la desserte et le résidentiel, dans cet ordre de gravité', () => {
    expect(malusVoie({ highway: 'trunk' })).toBe(0);
    expect(malusVoie({ highway: 'residential' })).toBe(5);
    expect(malusVoie({ highway: 'service' })).toBe(10);
    expect(malusVoie({ highway: 'trunk', bridge: 'yes' })).toBe(15);
    // Plafonné : le malus départage, il n'oppose pas un veto à une voie nettement plus proche.
    expect(malusVoie({ highway: 'service', bridge: 'yes' })).toBe(15);
  });
});

describe('voieLaPlusProche — le pont au-dessus de la rocade', () => {
  const rocade = voie(43.61009, { highway: 'trunk', maxspeed: '90' });
  const pont = voie(43.61009, { highway: 'residential', maxspeed: '30', bridge: 'yes', layer: '1' });

  it('retient la rocade quand le pont est un peu plus proche, mais pas franchement', () => {
    // Point à 6 m au nord de l'axe de la rocade ; le pont est à 4 m. Sans malus, le pont gagnait.
    const p = { lat: nord(43.61009, 6), lng: 1.3855 };
    const rocadeDecalee = voie(43.61009, { highway: 'trunk', maxspeed: '90' });
    const pontProche = voie(nord(43.61009, 10), { highway: 'residential', maxspeed: '30', bridge: 'yes' });

    const choisie = voieLaPlusProche(p, [pontProche, rocadeDecalee]);

    expect(choisie?.tags?.['maxspeed']).toBe('90');
  });

  it('retient quand même le pont quand le point est franchement dessus', () => {
    // Point à 1 m du pont et 20 m de la rocade : même avec 15 m de malus, le pont l'emporte.
    const pontHaut = voie(nord(43.61009, 20), { highway: 'residential', maxspeed: '30', bridge: 'yes' });
    const p = { lat: nord(43.61009, 21), lng: 1.3855 };

    const choisie = voieLaPlusProche(p, [rocade, pontHaut]);

    expect(choisie?.tags?.['maxspeed']).toBe('30');
  });

  it('ne rattache jamais une voie au-delà de la distance maximale, malus ou pas', () => {
    const loin = voie(nord(43.61009, 120), { highway: 'trunk' });
    expect(voieLaPlusProche({ lat: 43.61009, lng: 1.3855 }, [loin])).toBeNull();
  });

  it('préfère l’axe rapide à la contre-allée de desserte à distance comparable', () => {
    const contreAllee = voie(nord(43.61009, 8), { highway: 'service' });
    const p = { lat: nord(43.61009, 5), lng: 1.3855 };

    const choisie = voieLaPlusProche(p, [contreAllee, rocade]);

    expect(choisie?.tags?.['highway']).toBe('trunk');
  });

  it('ignore le pont quand il est seul mais hors de portée, plutôt que d’inventer', () => {
    expect(voieLaPlusProche({ lat: nord(43.61009, 200), lng: 1.3855 }, [rocade, pont])).toBeNull();
  });
});

describe('Analyse — un dépassement invraisemblable n’est pas affirmé', () => {
  function trajet(vitesses: number[]): RawPosition[] {
    let lat = 43.61009;
    return vitesses.map((v, i) => {
      const p = {
        lat, lng: 1.3855, speedKmh: v,
        timestamp: new Date(Date.UTC(2026, 7, 29, 14, 28, i * 20)),
        valid: true, ignition: true,
      } as RawPosition;
      // Déplacement cohérent avec la vitesse, pour ne pas déclencher le garde-fou du lot V1.
      lat = nord(lat, (v / 3.6) * 20);
      return p;
    });
  }

  it('range « 102 km/h sur une voie à 30 » dans les pointes à vérifier, pas dans les excès', () => {
    const r = analyzeTrip(trajet([100, 102, 101]), {}, () => 30);

    expect(r.speedingCount).toBe(0);
    expect(r.maxOverKmh).toBe(0);
    const motifs = (r.detail.aVerifier ?? []).map((x) => x.motif);
    expect(motifs).toContain('limite-invraisemblable');
    expect(r.detail.aVerifier?.[0]?.limitKmh).toBe(30);
  });

  it('compte normalement un excès crédible sur la même voie lente', () => {
    // 60 km/h dans une zone 30 : c'est une faute, pas un rattachement raté.
    const r = analyzeTrip(trajet([58, 60, 59]), {}, () => 30);

    expect(r.speedingCount).toBeGreaterThan(0);
    expect(r.maxOverKmh).toBeGreaterThan(25);
  });

  it('compte un gros dépassement sur une voie rapide, où il reste plausible', () => {
    // 150 sur une voie à 90 : +60, mais la limite n'est pas « lente » — on affirme.
    const r = analyzeTrip(trajet([148, 150, 149]), {}, () => 90);

    expect(r.speedingCount).toBeGreaterThan(0);
    expect(r.maxOverKmh).toBeGreaterThanOrEqual(58);
  });

  it('n’affirme pas un excès vu sur un seul point', () => {
    // Un seul point au-dessus de la limite, encadré de deux points en dessous.
    const r = analyzeTrip(trajet([80, 100, 80]), {}, () => 90);

    expect(r.speedingCount).toBe(0);
    expect((r.detail.aVerifier ?? []).map((x) => x.motif)).toContain('point-unique');
  });
});
