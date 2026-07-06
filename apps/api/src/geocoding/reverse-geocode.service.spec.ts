import { ReverseGeocodeService } from './reverse-geocode.service';

function makePrisma(over: Record<string, unknown> = {}) {
  return {
    geocodeCache: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    ...over,
  } as never;
}

describe('ReverseGeocodeService (P3 — géocodage inverse)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  it('cache HIT : renvoie le libellé mémorisé sans appel réseau', async () => {
    const prisma = makePrisma({
      geocodeCache: { findUnique: jest.fn().mockResolvedValue({ label: 'Carcassonne' }), create: jest.fn() },
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    const svc = new ReverseGeocodeService(prisma);

    expect(await svc.label(43.213, 2.351)).toBe('Carcassonne');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cache MISS : géocode via Nominatim, parse la ville, met en cache (clé arrondie)', async () => {
    const prisma = makePrisma();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ address: { town: 'Carcassonne' } }),
    }) as never;
    const svc = new ReverseGeocodeService(prisma);

    expect(await svc.label(43.2131, 2.3512)).toBe('Carcassonne');
    const data = (prisma as unknown as { geocodeCache: { create: jest.Mock } }).geocodeCache.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ label: 'Carcassonne', key: '43.213,2.351' });
  });

  it('géocodage sans résultat : renvoie null ET mémorise le vide (pas de reboucle)', async () => {
    const prisma = makePrisma();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ address: {} }) }) as never;
    const svc = new ReverseGeocodeService(prisma);

    expect(await svc.label(0.0001, 0.0002)).toBeNull();
    expect((prisma as unknown as { geocodeCache: { create: jest.Mock } }).geocodeCache.create.mock.calls[0][0].data.label).toBe('');
  });

  it('échec réseau : renvoie null (best-effort, jamais d\'exception)', async () => {
    const prisma = makePrisma();
    global.fetch = jest.fn().mockRejectedValue(new Error('network')) as never;
    const svc = new ReverseGeocodeService(prisma);

    await expect(svc.label(43.2, 2.35)).resolves.toBeNull();
  });
});
