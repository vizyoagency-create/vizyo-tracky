import { estDebranche, motifHorsService, MOTIF_DEBRANCHE } from './hors-service';

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

describe('estDebranche', () => {
  it('ne reconnaît que le boîtier débranché, pas les autres motifs', () => {
    expect(estDebranche('TRACKER_UNPLUGGED')).toBeTrue();
    expect(estDebranche('IMMOBILIZED')).toBeFalse();
    expect(estDebranche('ACCIDENT')).toBeFalse();
    expect(estDebranche(null)).toBeFalse();
    expect(estDebranche(undefined)).toBeFalse();
  });
});
