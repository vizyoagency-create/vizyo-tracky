import { RAYON_MEME_STATION_M, stationDuLieu, stationsCouvertes } from './stations-couvertes';

/** ≈ 1 m de latitude, en degrés. */
const M = 1 / 111_195;
const station = (stationId: string, nordM = 0) => ({ stationId, lat: 43.6 + nordM * M, lng: 1.44 });
const pompe = (over: Partial<{ kind: string; stationId: string | null; nordM: number }> = {}) => ({
  kind: over.kind ?? 'FUEL_STATION',
  stationId: over.stationId ?? null,
  lat: 43.6 + (over.nordM ?? 0) * M,
  lng: 1.44,
});

/**
 * Demande du 06/10/2026 : une station devenue lieu de la flotte (pompe) ne garde pas son rond
 * violet et son nombre de passages par-dessus.
 */
describe('stationsCouvertes', () => {
  it('🔴 couvre la station dont la pompe est issue, même si son centre a bougé depuis', () => {
    const c = stationsCouvertes([station('s-1', 500)], [pompe({ stationId: 's-1' })]);
    expect(c.has('s-1')).toBeTrue();
  });

  it('couvre une station détectée sous une pompe posée à la main (moins de 60 m)', () => {
    const c = stationsCouvertes([station('s-1', 40)], [pompe()]);
    expect(c.has('s-1')).toBeTrue();
  });

  it('ne couvre pas la station d’en face, au-delà du rayon', () => {
    const c = stationsCouvertes([station('s-2', RAYON_MEME_STATION_M + 15)], [pompe()]);
    expect(c.has('s-2')).toBeFalse();
  });

  it('ignore les lieux qui ne sont pas des pompes (parking, dépôt)', () => {
    const c = stationsCouvertes([station('s-1')], [pompe({ kind: 'PARKING' }), pompe({ kind: 'DEPOT' })]);
    expect(c.size).toBe(0);
  });

  it('ne couvre rien quand aucun lieu n’est affiché (calque des lieux masqué)', () => {
    expect(stationsCouvertes([station('s-1')], []).size).toBe(0);
  });
});

describe('stationDuLieu', () => {
  it('rend la station d’origine avant la plus proche', () => {
    const s = stationDuLieu(pompe({ stationId: 'loin' }), [station('pres', 5), station('loin', 300)]);
    expect(s?.stationId).toBe('loin');
  });

  it('sans lien, rend la plus proche dans le rayon', () => {
    const s = stationDuLieu(pompe(), [station('a', 50), station('b', 12), station('c', 200)]);
    expect(s?.stationId).toBe('b');
  });

  it('rend undefined hors rayon, et pour un lieu qui n’est pas une pompe', () => {
    expect(stationDuLieu(pompe(), [station('a', 200)])).toBeUndefined();
    expect(stationDuLieu(pompe({ kind: 'PARKING' }), [station('a')])).toBeUndefined();
  });

  it('se replie sur la distance quand la station d’origine n’est plus dans la période chargée', () => {
    const s = stationDuLieu(pompe({ stationId: 'disparue' }), [station('a', 20)]);
    expect(s?.stationId).toBe('a');
  });
});
