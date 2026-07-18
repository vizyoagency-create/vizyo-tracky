import { FleetPlaceKind } from '@prisma/client';
import { PlaceEnrichmentService } from './place-enrichment.service';

/**
 * Enrichissement OSM d'un lieu. On vérifie que les tags bruts Overpass deviennent des faits
 * exploitables (services, carburants, horaires, image), et surtout que le service ne LÈVE JAMAIS :
 * Overpass est communautaire, son indisponibilité ne doit pas casser la page Lieux clés.
 */
describe('PlaceEnrichmentService', () => {
  const errorLogger = { recordBackground: jest.fn() } as never;
  const build = () => new PlaceEnrichmentService(errorLogger);

  const mockOverpass = (elements: unknown[]) => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ elements }) }) as never;
  };

  beforeEach(() => jest.clearAllMocks());

  it('extrait les faits utiles d\'une station (horaires, services, carburants, contact)', async () => {
    mockOverpass([
      {
        type: 'node',
        id: 42,
        tags: {
          amenity: 'fuel',
          name: 'E.Leclerc Station Service',
          brand: 'E.Leclerc',
          opening_hours: '24/7',
          phone: '05 61 17 17 17',
          website: 'https://www.e-leclerc.com',
          car_wash: 'yes',
          compressed_air: 'yes',
          shop: 'convenience',
          'fuel:diesel': 'yes',
          'fuel:octane_95': 'yes',
          'payment:credit_cards': 'yes',
          'addr:housenumber': '16',
          'addr:street': 'Allée des Champs Pinsons',
          'addr:city': 'Saint-Orens-de-Gameville',
        },
      },
    ]);

    const facts = await build().enrich(43.55, 1.53, FleetPlaceKind.FUEL_STATION);

    expect(facts).not.toBeNull();
    expect(facts!.name).toBe('E.Leclerc Station Service');
    expect(facts!.brand).toBe('E.Leclerc');
    expect(facts!.openingHours).toBe('24/7');
    expect(facts!.phone).toBe('05 61 17 17 17');
    expect(facts!.website).toBe('https://www.e-leclerc.com');
    expect(facts!.services).toEqual(expect.arrayContaining(['Ouvert 24h/24', 'Lavage', 'Gonflage', 'Boutique']));
    expect(facts!.fuels).toEqual(expect.arrayContaining(['Gazole', 'SP95']));
    expect(facts!.payment).toContain('Carte bancaire');
    expect(facts!.address).toContain('Allée des Champs Pinsons');
    expect(facts!.osmId).toBe('node/42');
  });

  it('construit l\'URL d\'image depuis Wikimedia Commons', async () => {
    mockOverpass([{ type: 'node', id: 1, tags: { amenity: 'fuel', wikimedia_commons: 'File:Ma stationate.jpg' } }]);
    const facts = await build().enrich(43.5, 1.5, FleetPlaceKind.FUEL_STATION);
    expect(facts!.imageUrl).toContain('commons.wikimedia.org/wiki/Special:FilePath/');
    expect(facts!.imageUrl).toContain('width=640');
  });

  it('REJETTE une image non-https (pas de contenu mixte dans l\'UI)', async () => {
    mockOverpass([{ type: 'node', id: 1, tags: { amenity: 'fuel', image: 'http://exemple.test/p.jpg' } }]);
    const facts = await build().enrich(43.5, 1.5, FleetPlaceKind.FUEL_STATION);
    expect(facts!.imageUrl).toBeNull();
  });

  it('extrait la capacité et le type d\'un parking', async () => {
    mockOverpass([
      { type: 'way', id: 7, tags: { amenity: 'parking', capacity: '120', parking: 'underground', access: 'customers', fee: 'no' } },
    ]);
    const facts = await build().enrich(43.6, 1.44, FleetPlaceKind.PARKING);
    expect(facts!.parking).toEqual({ capacity: 120, type: 'underground', access: 'customers', fee: 'no' });
  });

  it('retient le POI le PLUS RICHE (pas simplement le premier)', async () => {
    mockOverpass([
      { type: 'node', id: 1, tags: { amenity: 'fuel' } },
      { type: 'way', id: 2, tags: { amenity: 'fuel', name: 'Complète', brand: 'Total', opening_hours: '24/7' } },
    ]);
    const facts = await build().enrich(43.5, 1.5, FleetPlaceKind.FUEL_STATION);
    expect(facts!.name).toBe('Complète');
  });

  it('renvoie null SANS lever quand Overpass est indisponible', async () => {
    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' })) as never;
    await expect(build().enrich(43.5, 1.5, FleetPlaceKind.FUEL_STATION)).resolves.toBeNull();
    // Indisponibilité ATTENDUE → on n'inonde pas le centre d'alerte.
    expect((errorLogger as unknown as { recordBackground: jest.Mock }).recordBackground).not.toHaveBeenCalled();
  });

  it('renvoie null quand aucun POI n\'est trouvé', async () => {
    mockOverpass([]);
    await expect(build().enrich(43.5, 1.5, FleetPlaceKind.FUEL_STATION)).resolves.toBeNull();
  });

  it('renvoie null sur coordonnées invalides sans appeler le réseau', async () => {
    global.fetch = jest.fn() as never;
    await expect(build().enrich(NaN, 1.5, FleetPlaceKind.FUEL_STATION)).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
