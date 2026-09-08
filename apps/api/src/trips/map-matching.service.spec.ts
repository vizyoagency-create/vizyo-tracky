import { MapMatchingService, OSRM_MAX_COORDONNEES } from './map-matching.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE RECALAGE SUR LES ROUTES PASSE PAR LOTS DE DIX — PARCE QUE LE SERVICE PUBLIC N'EN PREND PAS PLUS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Mesuré le 2026-09-08 contre `router.project-osrm.org`, sur un vrai trajet de production :
 * dix coordonnées passent, onze sont refusées (HTTP 400, corps vide) ; un rayon de 40 m
 * passe, 50 m est refusé. Le code envoyait des lots de CENT : tout trajet de plus de dix
 * points échouait, et la base le disait — 0 % de trajets recalés au-delà de 30 points,
 * 39 % entre 10 et 29, 100 % en dessous de 10.
 *
 * Ce qui est protégé ici : la taille des lots, leur chevauchement (sans lui, la route entre
 * deux lots resterait une droite), et le repli PAR LOT — un lot refusé ne doit plus faire
 * perdre tout le trajet.
 */
type Point = { lat: number; lng: number };

const points = (n: number): Point[] => Array.from({ length: n }, (_, i) => ({ lat: 43.6 + i * 0.001, lng: 1.43 + i * 0.001 }));

/** Les coordonnées envoyées dans une URL `/match/v1/driving/<lng,lat;…>?…`, dans l'ordre. */
function coordonneesDe(url: string): Point[] {
  const brut = decodeURIComponent(url).split('/match/v1/driving/')[1]!.split('?')[0]!;
  return brut.split(';').map((c) => { const [lng, lat] = c.split(',').map(Number); return { lat: lat!, lng: lng! }; });
}

/** OSRM « écho » : rend exactement les points reçus, comme géométrie recalée. */
const echo = async (url: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ code: 'Ok', matchings: [{ geometry: { type: 'LineString', coordinates: coordonneesDe(url).map((p) => [p.lng, p.lat]) } }] }),
});
const refus = async () => ({ ok: false, status: 400, json: async () => ({ code: 'NoMatch' }) });

describe('MapMatchingService — recalage OSRM par lots', () => {
  let fetchMock: jest.Mock;
  const service = () => {
    const s = new MapMatchingService();
    (s as unknown as { pauseMs: number }).pauseMs = 0;
    return s;
  };

  beforeEach(() => {
    fetchMock = jest.fn(echo);
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  it('🔴 découpe en lots de dix coordonnées au plus, chaque lot repartant du dernier point du précédent', async () => {
    const r = await service().match(points(25));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const lots = fetchMock.mock.calls.map((c) => coordonneesDe(c[0] as string));
    for (const lot of lots) expect(lot.length).toBeLessThanOrEqual(OSRM_MAX_COORDONNEES);
    // Chevauchement d'un point : sans lui, la route entre deux lots resterait une droite.
    expect(lots[1]![0]).toEqual(lots[0]![lots[0]!.length - 1]);
    expect(lots[2]![0]).toEqual(lots[1]![lots[1]!.length - 1]);
    // Et rien n'est perdu ni doublé : l'écho rend les 25 points, une seule fois chacun.
    expect(r).toHaveLength(25);
    expect(r![0]).toEqual({ lat: 43.6, lng: 1.43 });
    expect(r![24]).toEqual(points(25)[24]);
  });

  it('🔴 un lot refusé garde ses points bruts, les autres restent recalés — le trajet n’est plus perdu en entier', async () => {
    fetchMock.mockImplementation(async (url: string) => (coordonneesDe(url)[0]!.lat > 43.608 && coordonneesDe(url)[0]!.lat < 43.612 ? refus() : echo(url)));

    const r = await service().match(points(25));

    expect(r).not.toBeNull();
    expect(r).toHaveLength(25);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('🔴 rend null seulement si AUCUN lot n’a pu être recalé', async () => {
    fetchMock.mockImplementation(refus);

    expect(await service().match(points(25))).toBeNull();
  });

  it('moins de deux points : rien à recaler, aucune requête', async () => {
    expect(await service().match(points(1))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exactement dix points : un seul lot', async () => {
    const r = await service().match(points(10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r).toHaveLength(10);
  });

  it('demande le rayon de 25 m sur chaque coordonnée, comme avant', async () => {
    await service().match(points(4));
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('radiuses=25;25;25;25');
  });
});
