import {
  CADENCE_PEREMPTION_PLANCHER_MS,
  cadenceMesurePerimee,
} from './peremption-cadence';

/**
 * TRK-048 — péremption de la cadence mesurée. Instants FIGÉS (leçon TRK-044) : `NOW` est
 * arbitraire, seuls les écarts décident.
 */
const NOW = new Date('2026-08-25T01:11:00.000Z').getTime();
const min = (n: number) => n * 60_000;
const h = (n: number) => n * 3_600_000;

describe('cadenceMesurePerimee (TRK-048)', () => {
  it('le cas mesuré en production (FS-253-HR) : « 1 s » figé, dernière trame valide 10,6 h — PÉRIMÉ', () => {
    expect(
      cadenceMesurePerimee({ currentFixIntervalS: 1, lastValidFrameAt: new Date(NOW - h(10.6)) }, NOW),
    ).toBe(true);
  });

  it('un émetteur réellement rapide (5 s, trame valide il y a 8 s) est MESURABLE', () => {
    expect(
      cadenceMesurePerimee({ currentFixIntervalS: 5, lastValidFrameAt: new Date(NOW - 8_000) }, NOW),
    ).toBe(false);
  });

  it('un boîtier garé au heartbeat horaire (3600 s, trame il y a 30 min) reste MESURABLE — le plancher ne s\'applique qu\'aux petites cadences', () => {
    expect(
      cadenceMesurePerimee({ currentFixIntervalS: 3600, lastValidFrameAt: new Date(NOW - min(30)) }, NOW),
    ).toBe(false);
    // ...et se périme au-delà de 3 × sa propre mesure (3 h).
    expect(
      cadenceMesurePerimee({ currentFixIntervalS: 3600, lastValidFrameAt: new Date(NOW - h(4)) }, NOW),
    ).toBe(true);
  });

  it('le plancher de 3 min absorbe la gigue d\'un boîtier à 20 s : une trame vieille de 2 min ne périme pas', () => {
    expect(
      cadenceMesurePerimee({ currentFixIntervalS: 20, lastValidFrameAt: new Date(NOW - min(2)) }, NOW),
    ).toBe(false);
    expect(
      cadenceMesurePerimee(
        { currentFixIntervalS: 20, lastValidFrameAt: new Date(NOW - CADENCE_PEREMPTION_PLANCHER_MS - 1_000) },
        NOW,
      ),
    ).toBe(true);
  });

  it('aucune mesure (null) → rien à périmer ; une mesure sans provenance → périmée par construction', () => {
    expect(cadenceMesurePerimee({ currentFixIntervalS: null, lastValidFrameAt: null }, NOW)).toBe(false);
    expect(cadenceMesurePerimee({ currentFixIntervalS: 30, lastValidFrameAt: null }, NOW)).toBe(true);
  });
});
