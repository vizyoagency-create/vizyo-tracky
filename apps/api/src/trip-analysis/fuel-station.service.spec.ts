import { FuelStationService, fuelTypeFor, priceForType, haversineM, type GouvStation } from './fuel-station.service';

describe('fuelTypeFor', () => {
  it('mappe l\'énergie du véhicule vers un carburant de l\'API', () => {
    expect(fuelTypeFor('DIESEL')).toBe('gazole');
    expect(fuelTypeFor('Gazole')).toBe('gazole');
    expect(fuelTypeFor('ESSENCE')).toBe('e10');
    expect(fuelTypeFor('gasoline')).toBe('e10');
    expect(fuelTypeFor('SP98')).toBe('sp98');
    expect(fuelTypeFor('GPL')).toBe('gplc');
    expect(fuelTypeFor('Superéthanol E85')).toBe('e85');
  });
  it('électrique / hybride / inconnu → null (pas de carburant liquide)', () => {
    expect(fuelTypeFor('ELECTRIC')).toBeNull();
    expect(fuelTypeFor('HYBRID')).toBeNull();
    expect(fuelTypeFor(null)).toBeNull();
    expect(fuelTypeFor('bogus')).toBeNull();
  });
});

describe('priceForType', () => {
  const s: GouvStation = { id: 1, gazole_prix: 1.86, sp95_prix: 1.9, e10_prix: null, gplc_prix: 1.1 };
  it('renvoie le prix du carburant demandé', () => {
    expect(priceForType(s, 'gazole')).toBe(1.86);
    expect(priceForType(s, 'gplc')).toBe(1.1);
  });
  it('e10 absent → repli sur sp95 (essence)', () => {
    expect(priceForType(s, 'e10')).toBe(1.9);
  });
  it('carburant absent et sans repli → null', () => {
    expect(priceForType({ id: 2 }, 'sp98')).toBeNull();
  });
});

describe('haversineM', () => {
  it('~111 m pour 0.001° de latitude', () => {
    expect(haversineM(43.6, 1.44, 43.601, 1.44)).toBeGreaterThan(105);
    expect(haversineM(43.6, 1.44, 43.601, 1.44)).toBeLessThan(115);
  });
  it('0 pour un point identique', () => {
    expect(haversineM(43.6, 1.44, 43.6, 1.44)).toBe(0);
  });
});

describe('FuelStationService.detectAndPersist', () => {
  const OLD_FETCH = global.fetch;
  afterEach(() => { global.fetch = OLD_FETCH; jest.restoreAllMocks(); });

  const station: GouvStation = {
    id: 31200999, geom: { lat: 43.6161, lon: 1.4211 }, adresse: '10 av. de la Station', ville: 'Toulouse', cp: '31200',
    gazole_prix: 1.886, gazole_maj: '2026-07-04 10:00:00', sp98_prix: 1.978, sp98_maj: '2026-07-04 10:00:00',
  };

  const makePrisma = () => ({
    tripFuelStop: { deleteMany: jest.fn().mockResolvedValue({}), create: jest.fn().mockResolvedValue({}) },
    fuelStation: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'st1', brand: 'Total', name: null, city: 'Toulouse', address: '10 av. de la Station', lat: 43.6161, lng: 1.4211 }),
    },
    fuelStationPrice: { upsert: jest.fn().mockResolvedValue({}) },
  });

  it('un arrêt SUR une station (diesel) → passage persisté avec prix gazole + marque OSM', async () => {
    global.fetch = jest.fn((url: string) => {
      const u = String(url);
      if (u.includes('data.economie.gouv.fr')) return Promise.resolve({ ok: true, json: async () => ({ results: [station] }) });
      if (u.includes('overpass')) return Promise.resolve({ ok: true, json: async () => ({ elements: [{ tags: { brand: 'Total' } }] }) });
      return Promise.reject(new Error('URL inattendue'));
    }) as unknown as typeof fetch;

    const prisma = makePrisma();
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const svc = new FuelStationService(prisma as never, errorLogger as never);

    const stops = [{ lat: 43.6161, lng: 1.4211, arrivedAt: '2026-07-05T10:00:00.000Z', leftAt: '2026-07-05T10:06:00.000Z', durationMin: 6 }];
    const res = await svc.detectAndPersist({ tripId: 't1', fleetId: 'f1', vehicleId: 'v1', energy: 'DIESEL' }, stops);

    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ stationId: 'st1', brand: 'Total', city: 'Toulouse', fuelType: 'gazole', unitPriceEur: 1.886, durationSec: 360 });
    // Passage persisté avec le bon carburant/prix
    expect(prisma.tripFuelStop.create).toHaveBeenCalledTimes(1);
    expect(prisma.tripFuelStop.create.mock.calls[0][0].data).toMatchObject({ tripId: 't1', stationId: 'st1', fuelType: 'gazole', unitPriceEur: 1.886 });
    // Prix historisés (gazole + sp98)
    expect(prisma.fuelStationPrice.upsert).toHaveBeenCalledTimes(2);
    // Re-analyse idempotente : purge d'abord
    expect(prisma.tripFuelStop.deleteMany).toHaveBeenCalledWith({ where: { tripId: 't1' } });
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('arrêt LOIN de toute station → aucun passage, aucune alerte', async () => {
    global.fetch = jest.fn((url: string) => {
      if (String(url).includes('data.economie.gouv.fr')) return Promise.resolve({ ok: true, json: async () => ({ results: [] }) });
      return Promise.reject(new Error('URL inattendue'));
    }) as unknown as typeof fetch;
    const prisma = makePrisma();
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const svc = new FuelStationService(prisma as never, errorLogger as never);

    const res = await svc.detectAndPersist({ tripId: 't1', fleetId: 'f1', vehicleId: 'v1', energy: 'DIESEL' },
      [{ lat: 43.7, lng: 1.5, arrivedAt: '2026-07-05T10:00:00.000Z', leftAt: '2026-07-05T10:06:00.000Z', durationMin: 6 }]);

    expect(res).toHaveLength(0);
    expect(prisma.tripFuelStop.create).not.toHaveBeenCalled();
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('API prix indisponible pour TOUS les arrêts → UNE alerte source `fuel-station`, analyse non bloquée', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const prisma = makePrisma();
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const svc = new FuelStationService(prisma as never, errorLogger as never);

    const res = await svc.detectAndPersist({ tripId: 't1', fleetId: 'f1', vehicleId: 'v1', energy: 'DIESEL' },
      [{ lat: 43.6161, lng: 1.4211, arrivedAt: '2026-07-05T10:00:00.000Z', leftAt: '2026-07-05T10:06:00.000Z', durationMin: 6 }]);

    expect(res).toHaveLength(0);
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    const [, source, ctx] = errorLogger.record.mock.calls[0];
    expect(source).toBe('fuel-station');
    expect(ctx).toMatchObject({ stage: 'lookup' });
  });

  it('sans arrêt → no-op (juste la purge idempotente)', async () => {
    const prisma = makePrisma();
    const errorLogger = { record: jest.fn() };
    const svc = new FuelStationService(prisma as never, errorLogger as never);
    const res = await svc.detectAndPersist({ tripId: 't1', fleetId: 'f1', vehicleId: 'v1', energy: 'DIESEL' }, []);
    expect(res).toHaveLength(0);
    expect(prisma.tripFuelStop.deleteMany).toHaveBeenCalled();
    expect(prisma.tripFuelStop.create).not.toHaveBeenCalled();
  });
});
