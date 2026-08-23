import {
  diagnostiquer,
  diagnosticsActionnables,
  distanceM,
  type ZoneBrute,
} from './gps-diagnostic.shared';

/**
 * Qualité GPS — le module de diagnostic.
 *
 * Ce qui est verrouillé ici n'est pas la formulation des phrases mais les CONCLUSIONS. Se tromper
 * de conclusion coûte cher dans les deux sens : accuser un boîtier sain envoie un technicien pour
 * rien, et blanchir un boîtier mourant laisse une flotte sans suivi.
 */
describe('gps-diagnostic.shared', () => {
  const TOULOUSE = { lat: 43.6045, lng: 1.4442 };

  /** Décale un point de `m` mètres vers l'est — de quoi placer des zones à distance connue. */
  function decale(base: { lat: number; lng: number }, m: number) {
    return { lat: base.lat, lng: base.lng + m / (111_320 * Math.cos((base.lat * Math.PI) / 180)) };
  }

  function zone(over: Partial<ZoneBrute> & { id: string; vehicleId: string }): ZoneBrute {
    return {
      fleetId: 'f1',
      plaque: over.vehicleId.toUpperCase(),
      centroidLat: TOULOUSE.lat,
      centroidLng: TOULOUSE.lng,
      radiusM: 80,
      occurrences: 3,
      firstSeenAt: new Date('2026-07-01'),
      lastSeenAt: new Date('2026-08-01'),
      placeLabel: null,
      ...over,
    } as ZoneBrute;
  }

  it('mesure correctement une distance connue', () => {
    const d = distanceM(TOULOUSE.lat, TOULOUSE.lng, decale(TOULOUSE, 1000).lat, decale(TOULOUSE, 1000).lng);
    expect(Math.abs(d - 1000)).toBeLessThan(15);
  });

  // ─── Le lieu ───────────────────────────────────────────────────────────────

  it('deux véhicules au même endroit : c’est le LIEU, pas les boîtiers', () => {
    const d = diagnostiquer([
      zone({ id: 'z1', vehicleId: 'aa', placeLabel: 'Parking Capitole' }),
      zone({ id: 'z2', vehicleId: 'bb', centroidLat: decale(TOULOUSE, 120).lat, centroidLng: decale(TOULOUSE, 120).lng }),
    ]);
    const lieu = d.find((x) => x.nature === 'lieu');
    expect(lieu).toBeDefined();
    expect(lieu!.vehicules).toEqual(['AA', 'BB']);
    // Le dire evite qu'un technicien parte controler des boitiers qui fonctionnent.
    expect(lieu!.recommandation).toMatch(/aucun boîtier n'est en cause/i);
    expect(lieu!.gravite).toBe('basse');
  });

  it('reprend le libellé du lieu quand il est connu', () => {
    const d = diagnostiquer([
      zone({ id: 'z1', vehicleId: 'aa', placeLabel: 'Parking Capitole' }),
      zone({ id: 'z2', vehicleId: 'bb' }),
    ]);
    expect(d[0].constat).toContain('Parking Capitole');
  });

  it('ne fusionne pas deux endroits éloignés en une seule zone', () => {
    const loin = decale(TOULOUSE, 5000);
    const d = diagnostiquer([
      zone({ id: 'z1', vehicleId: 'aa' }),
      zone({ id: 'z2', vehicleId: 'bb' }),
      zone({ id: 'z3', vehicleId: 'aa', centroidLat: loin.lat, centroidLng: loin.lng }),
      zone({ id: 'z4', vehicleId: 'bb', centroidLat: loin.lat, centroidLng: loin.lng }),
    ]);
    // Deux lieux distincts, pas un « quartier » de 5 km.
    expect(d.filter((x) => x.nature === 'lieu')).toHaveLength(2);
  });

  // ─── Le boîtier ────────────────────────────────────────────────────────────

  it('un véhicule qui perd le signal PARTOUT — là où la flotte circule : c’est le BOÎTIER', () => {
    // TRK-039 : les zones portent désormais leur corroboration — d'autres véhicules passent
    // ici sans perdre le signal, donc la contre-preuve est TESTABLE et elle accuse l'appareil.
    const zones = [0, 4000, 9000, 15_000].map((m, i) => {
      const p = decale(TOULOUSE, m);
      return zone({ id: `z${i}`, vehicleId: 'zz', centroidLat: p.lat, centroidLng: p.lng, occurrences: 4, vehiculesTiersSurSecteur: 2 });
    });
    const d = diagnostiquer(zones);
    const b = d.find((x) => x.nature === 'boitier');
    expect(b).toBeDefined();
    expect(b!.recommandation).toMatch(/antenne|fixation|alimentation/i);
    expect(b!.constat).toMatch(/d'autres véhicules de la flotte circulent/);
    // 16 episodes : c'est serieux.
    expect(b!.gravite).toBe('haute');
  });

  it('un véhicule à UN SEUL endroit ne conclut à RIEN', () => {
    const d = diagnostiquer([zone({ id: 'z1', vehicleId: 'aa', occurrences: 12 })]);
    // C'est presque toujours son parking habituel. Conclure « boitier defaillant » enverrait un
    // technicien pour rien.
    expect(d[0].nature).toBe('indetermine');
    expect(d[0].recommandation).toBe('');
  });

  it('quatre pertes RAPPROCHÉES ne font pas un boîtier défaillant', () => {
    const zones = [0, 100, 200, 250].map((m, i) => {
      const p = decale(TOULOUSE, m);
      return zone({ id: `z${i}`, vehicleId: 'aa', centroidLat: p.lat, centroidLng: p.lng });
    });
    // Elles designent un endroit, pas un comportement : l'etalement fait la difference.
    expect(diagnostiquer(zones)[0].nature).toBe('indetermine');
  });

  it('un véhicule qui fréquente des lieux DÉJÀ expliqués n’est pas accusé', () => {
    // aa passe par trois parkings ou d'autres vehicules perdent aussi le signal.
    const points = [0, 6000, 12_000, 18_000].map((m) => decale(TOULOUSE, m));
    const zones: ZoneBrute[] = [];
    points.forEach((p, i) => {
      zones.push(zone({ id: `a${i}`, vehicleId: 'aa', centroidLat: p.lat, centroidLng: p.lng }));
      zones.push(zone({ id: `b${i}`, vehicleId: 'bb', centroidLat: p.lat, centroidLng: p.lng }));
    });
    const d = diagnostiquer(zones);
    // Les quatre lieux sont partagés : personne n'est mis en cause.
    expect(d.filter((x) => x.nature === 'lieu')).toHaveLength(4);
    expect(d.filter((x) => x.nature === 'boitier')).toHaveLength(0);
  });

  // ─── Ce qu'on remonte ──────────────────────────────────────────────────────

  it('ne remonte que ce sur quoi on a conclu', () => {
    const d = diagnostiquer([zone({ id: 'z1', vehicleId: 'aa' })]);
    expect(diagnosticsActionnables(d)).toHaveLength(0);
  });

  it('classe le plus grave en premier', () => {
    // ⚠️ On décale à partir de 30 km : à 0 m, la première zone de `zz` tomberait sur le lieu
    //    partagé par `aa` et `bb`, serait expliquée par lui, et `zz` redescendrait sous le seuil.
    //    Comportement correct de l'algorithme — mais jeu de données trompeur.
    const eparpille = [30_000, 35_000, 41_000, 47_000].map((m, i) => {
      const p = decale(TOULOUSE, m);
      return zone({ id: `g${i}`, vehicleId: 'zz', centroidLat: p.lat, centroidLng: p.lng, occurrences: 5, vehiculesTiersSurSecteur: 1 });
    });
    const partage = [zone({ id: 'p1', vehicleId: 'aa' }), zone({ id: 'p2', vehicleId: 'bb' })];
    const d = diagnostiquer([...partage, ...eparpille]);
    expect(d[0].nature).toBe('boitier');
  });

  it('rend une liste vide sans zones', () => {
    expect(diagnostiquer([])).toEqual([]);
  });

  // ─── TRK-039 — la corroboration rend la contre-preuve testable ────────────

  it('🔑 le cas KSR370 : des zones que personne d’autre ne fréquente ne font plus un boîtier', () => {
    // 6 zones, ~580 km d'étalement (Toulouse–Benidorm), AUCUNE corroboration : personne
    // d'autre de la flotte ne va là-bas. « Sans qu'aucun autre véhicule n'ait le même
    // problème » y est invérifiable — une absence de preuve n'est pas une preuve.
    // C'est le test qui aurait attrapé l'incident du 21/08.
    const points = [0, 500, 1000, 579_000, 580_000, 580_500].map((m) => decale(TOULOUSE, m));
    const zones = points.map((p, i) =>
      zone({ id: `k${i}`, vehicleId: 'ksr370', centroidLat: p.lat, centroidLng: p.lng, occurrences: 2 }),
    );
    const d = diagnostiquer(zones);
    expect(d.filter((x) => x.nature === 'boitier')).toHaveLength(0);
    expect(d[0].nature).toBe('indetermine');
    expect(diagnosticsActionnables(d)).toHaveLength(0);
  });

  it('l’étalement se mesure sur l’aire d’exploitation partagée, pas sur la distance parcourue', () => {
    // 4 zones corroborées resserrées (< 2 km) + 2 zones lointaines non corroborées à 500 km :
    // les lointaines ne comptent ni pour le seuil ni pour l'étalement.
    const proches = [0, 600, 1200, 1800].map((m, i) => {
      const p = decale(TOULOUSE, m);
      return zone({ id: `p${i}`, vehicleId: 'aa', centroidLat: p.lat, centroidLng: p.lng, vehiculesTiersSurSecteur: 1 });
    });
    const lointaines = [500_000, 501_000].map((m, i) => {
      const p = decale(TOULOUSE, m);
      return zone({ id: `l${i}`, vehicleId: 'aa', centroidLat: p.lat, centroidLng: p.lng });
    });
    const d = diagnostiquer([...proches, ...lointaines]);
    expect(d.filter((x) => x.nature === 'boitier')).toHaveLength(0);
  });

  it('les zones corroborées suffisent, même mêlées à des zones lointaines non corroborées', () => {
    const corroborees = [0, 4000, 9000, 15_000].map((m, i) => {
      const p = decale(TOULOUSE, m);
      return zone({ id: `c${i}`, vehicleId: 'aa', centroidLat: p.lat, centroidLng: p.lng, occurrences: 3, vehiculesTiersSurSecteur: 1 });
    });
    const lointaines = [500_000, 501_000].map((m, i) => {
      const p = decale(TOULOUSE, m);
      return zone({ id: `x${i}`, vehicleId: 'aa', centroidLat: p.lat, centroidLng: p.lng, occurrences: 9 });
    });
    const d = diagnostiquer([...corroborees, ...lointaines]);
    const b = d.find((x) => x.nature === 'boitier');
    expect(b).toBeDefined();
    // Le diagnostic ne référence QUE ce qui fonde le verdict — compter Benidorm dans les
    // épisodes referait mentir le constat par la bande.
    expect(b!.zoneIds).toHaveLength(4);
    expect(b!.etalementM).toBeLessThan(20_000);
    expect(b!.episodes).toBe(12);
  });

  it('corroboration ABSENTE = corroboration NULLE — le défaut sûr', () => {
    // Fige la sémantique `undefined ?? 0` : une corroboration qu'on n'a pas mesurée
    // n'est pas une preuve.
    const zones = [0, 4000, 9000, 15_000].map((m, i) => {
      const p = decale(TOULOUSE, m);
      return zone({ id: `u${i}`, vehicleId: 'aa', centroidLat: p.lat, centroidLng: p.lng });
    });
    const d = diagnostiquer(zones);
    expect(d.filter((x) => x.nature === 'boitier')).toHaveLength(0);
  });
});
