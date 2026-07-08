import { parseMaxspeed, inferFromHighway, SpeedLimitService } from './speed-limit.service';

describe('parseMaxspeed', () => {
  it('nombres, mph, catégories FR, cas spéciaux', () => {
    expect(parseMaxspeed('50')).toBe(50);
    expect(parseMaxspeed('30 mph')).toBe(48);
    expect(parseMaxspeed('FR:urban')).toBe(50);
    expect(parseMaxspeed('FR:motorway')).toBe(130);
    expect(parseMaxspeed('FR:rural')).toBe(80);
    expect(parseMaxspeed('walk')).toBe(6);
  });
  it('inconnu / vide → null (jamais un faux nombre)', () => {
    expect(parseMaxspeed('none')).toBeNull();
    expect(parseMaxspeed('bogus')).toBeNull();
    expect(parseMaxspeed('')).toBeNull();
    expect(parseMaxspeed(undefined)).toBeNull();
  });
});

describe('inferFromHighway', () => {
  it('défauts FR par type de voie', () => {
    expect(inferFromHighway('motorway')).toBe(130);
    expect(inferFromHighway('trunk')).toBe(110);
    expect(inferFromHighway('residential')).toBe(50);
    expect(inferFromHighway('living_street')).toBe(20);
  });
  it('type inconnu / non routable → null', () => {
    expect(inferFromHighway('footway')).toBeNull();
    expect(inferFromHighway('unknown_type')).toBeNull();
    expect(inferFromHighway(undefined)).toBeNull();
  });
});

describe('SpeedLimitService — traçabilité Overpass (centre d\'alerte)', () => {
  const OLD_FETCH = global.fetch;
  afterEach(() => { global.fetch = OLD_FETCH; jest.restoreAllMocks(); });

  const makePrisma = () => ({ speedLimitCache: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) } });

  it('Overpass injoignable pour TOUS les points → UNE alerte source `trip-analysis` (best-effort, non bloquant)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const prisma = makePrisma();
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const svc = new SpeedLimitService(prisma as never, errorLogger as never);

    const resolver = await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]);

    expect(resolver(43.6, 1.44)).toBeNull(); // limite inconnue : l'analyse reste valable
    expect(errorLogger.record).toHaveBeenCalledTimes(1); // mais l'indispo est TRACÉE une seule fois
    const [, source, ctx] = errorLogger.record.mock.calls[0];
    expect(source).toBe('trip-analysis');
    expect(ctx).toMatchObject({ feature: 'speed-limit-osm' });
    expect(prisma.speedLimitCache.create).not.toHaveBeenCalled(); // un échec transport ne cache rien (retry plus tard)
  });

  it('Overpass répond (aucune route → null légitime) → AUCUNE alerte parasite', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ elements: [] }) }) as unknown as typeof fetch;
    const prisma = makePrisma();
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const svc = new SpeedLimitService(prisma as never, errorLogger as never);

    const resolver = await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]);

    expect(resolver(43.6, 1.44)).toBeNull();
    expect(errorLogger.record).not.toHaveBeenCalled();
    expect(prisma.speedLimitCache.create).toHaveBeenCalledTimes(1); // résolution légitime → mémorisée
  });
});
