import {
  estAccidente,
  estDebranche,
  estImmobilise,
  motifHorsService,
  MOTIF_ACCIDENT,
  MOTIF_DEBRANCHE,
  MOTIF_IMMOBILISE,
  nbAccidentesSurLaCarte,
  nbDebranchesSurLaCarte,
  nbImmobilisesSurLaCarte,
} from './hors-service';

/**
 * Le motif « hors service » vu par la carte : l'instantané temps réel fait foi dès qu'il porte
 * le champ, la liste des véhicules n'est qu'un repli.
 */
describe('motifHorsService — quelle source croire', () => {
  it('retient l’instantané quand il porte le motif', () => {
    expect(motifHorsService({ outOfServiceReason: MOTIF_DEBRANCHE }, { outOfServiceReason: null }))
      .toBe(MOTIF_DEBRANCHE);
  });

  /**
   * Le piège du `??` : remis en service sur la fiche, le véhicule a `null` dans l'instantané
   * rafraîchi, mais la liste chargée à l'ouverture de la carte dit encore « débranché ».
   */
  it('🔴 un `null` de l’instantané (remis en service) l’emporte sur un « débranché » périmé', () => {
    expect(motifHorsService({ outOfServiceReason: null }, { outOfServiceReason: MOTIF_DEBRANCHE }))
      .toBeNull();
  });

  it('se replie sur la liste quand l’instantané ne connaît pas le champ (API d’avant le 05/10)', () => {
    expect(motifHorsService({}, { outOfServiceReason: MOTIF_DEBRANCHE })).toBe(MOTIF_DEBRANCHE);
    expect(motifHorsService(undefined, { outOfServiceReason: MOTIF_DEBRANCHE })).toBe(MOTIF_DEBRANCHE);
  });

  it('rend null quand personne ne sait rien', () => {
    expect(motifHorsService(undefined, undefined)).toBeNull();
    expect(motifHorsService({}, {})).toBeNull();
  });
});

/**
 * La légende « Boîtier débranché (n) » compte ce que la carte MONTRE. Cas réel du 05/10 au soir,
 * vue « Toutes les sociétés » : 4 débranchés déclarés, dont FT-463-TW sans boîtier — 3 marqueurs.
 */
describe('nbDebranchesSurLaCarte', () => {
  const position = { trackerId: 't', lastLat: 43.64, lastLng: 1.45 };

  it('🔴 ne compte pas un débranché qui n’a jamais eu de boîtier ni de position (FT-463-TW)', () => {
    expect(nbDebranchesSurLaCarte([
      { ...position, outOfServiceReason: MOTIF_DEBRANCHE },                 // DZ-034-CA
      { ...position, outOfServiceReason: MOTIF_DEBRANCHE },                 // FS-253-HR
      { ...position, outOfServiceReason: MOTIF_DEBRANCHE },                 // FS-808-CE
      { trackerId: null, lastLat: null, lastLng: null, outOfServiceReason: MOTIF_DEBRANCHE }, // FT-463-TW
    ])).toBe(3);
  });

  it('ne compte pas un boîtier qui n’a encore jamais émis de position', () => {
    expect(nbDebranchesSurLaCarte([{ trackerId: 't', lastLat: null, lastLng: null, outOfServiceReason: MOTIF_DEBRANCHE }])).toBe(0);
  });

  it('ne compte ni les immobilisés ni les véhicules en service', () => {
    expect(nbDebranchesSurLaCarte([
      { ...position, outOfServiceReason: 'IMMOBILIZED' },
      { ...position, outOfServiceReason: null },
      { ...position },
    ])).toBe(0);
  });
});

describe('estDebranche', () => {
  it('ne reconnaît que le boîtier débranché, pas les autres motifs', () => {
    expect(estDebranche('TRACKER_UNPLUGGED')).toBeTrue();
    expect(estDebranche('IMMOBILIZED')).toBeFalse();
    expect(estDebranche('ACCIDENT')).toBeFalse();
    expect(estDebranche(null)).toBeFalse();
    expect(estDebranche(undefined)).toBeFalse();
  });
});

/** Immobilisé (06/10/2026) : même règle, autre motif. */
describe('estImmobilise et nbImmobilisesSurLaCarte', () => {
  const position = { trackerId: 't', lastLat: 43.66, lastLng: 1.42 };

  it('ne reconnaît que le motif « immobilisé »', () => {
    expect(estImmobilise(MOTIF_IMMOBILISE)).toBeTrue();
    expect(estImmobilise(MOTIF_DEBRANCHE)).toBeFalse();
    expect(estImmobilise('ACCIDENT')).toBeFalse();
    expect(estImmobilise(null)).toBeFalse();
  });

  it('compte les immobilisés qui ont une position, et eux seuls', () => {
    expect(nbImmobilisesSurLaCarte([
      { ...position, outOfServiceReason: MOTIF_IMMOBILISE },               // HD-998-XY
      { ...position, outOfServiceReason: MOTIF_IMMOBILISE },               // HM-787-GA
      { trackerId: 't', lastLat: null, lastLng: null, outOfServiceReason: MOTIF_IMMOBILISE },
      { ...position, outOfServiceReason: MOTIF_DEBRANCHE },
    ])).toBe(2);
  });
});

/** Accidenté (06/10/2026) : même règle, troisième motif. */
describe('estAccidente et nbAccidentesSurLaCarte', () => {
  const position = { trackerId: 't', lastLat: 43.6, lastLng: 1.44 };

  it('ne reconnaît que le motif « accidenté »', () => {
    expect(estAccidente(MOTIF_ACCIDENT)).toBeTrue();
    expect(estAccidente(MOTIF_IMMOBILISE)).toBeFalse();
    expect(estAccidente(MOTIF_DEBRANCHE)).toBeFalse();
    expect(estAccidente(null)).toBeFalse();
  });

  it('compte les accidentés qui ont une position, et eux seuls', () => {
    expect(nbAccidentesSurLaCarte([
      { ...position, outOfServiceReason: MOTIF_ACCIDENT },
      { trackerId: null, lastLat: null, lastLng: null, outOfServiceReason: MOTIF_ACCIDENT },
      { ...position, outOfServiceReason: MOTIF_IMMOBILISE },
    ])).toBe(1);
  });
});
