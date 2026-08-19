import { parseMaxspeed, inferFromHighway, distancePointSegment, SpeedLimitService } from './speed-limit.service';

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

describe('distancePointSegment', () => {
  it('un point SUR le segment est à distance nulle', () => {
    expect(distancePointSegment(43.6, 1.44, 43.6, 1.4398, 43.6, 1.4402)).toBeLessThan(1);
  });
  it('mesure une distance plausible en mètres', () => {
    // 0,001° de latitude ≈ 111 m.
    const d = distancePointSegment(43.601, 1.44, 43.6, 1.4398, 43.6, 1.4402);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });
  it('se rabat sur l’extrémité quand la projection tombe hors du segment', () => {
    const d = distancePointSegment(43.6, 1.5, 43.6, 1.4398, 43.6, 1.4402);
    expect(d).toBeGreaterThan(4_000); // ~4,8 km à l’est de l’extrémité
  });
});

/**
 * ── LE BUG QUE CES TESTS EMPÊCHENT DE REVENIR ────────────────────────────────────────
 *
 * Relevé du 2026-08-19 en production : 59 347 points sur 60 090 (98,8 %) étaient mémorisés
 * « limite inconnue » — DÉFINITIVEMENT. Deux d'entre eux, rejoués à la main, renvoyaient
 * pourtant `motorway_link maxspeed=70` et `highway=tertiary`. La donnée OSM existait.
 *
 * La cause : Overpass sert ses erreurs de surcharge SOUS UN HTTP 200, tantôt en HTML, tantôt
 * en JSON valide portant un champ `remark`. Le code lisait la liste vide comme « aucune route
 * ici » et la gravait dans le cache. Résultat : 75,3 % des trajets sans aucune limite résolue,
 * donc aucun excès calculable, donc un score de conduite moyen de 93,4/100 qui ne mesurait rien.
 */
describe('SpeedLimitService — ne JAMAIS graver un échec Overpass dans le cache', () => {
  const OLD_FETCH = global.fetch;
  afterEach(() => { global.fetch = OLD_FETCH; jest.restoreAllMocks(); });

  const makePrisma = () => ({
    speedLimitCache: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
  });
  const reponse = (corps: unknown) => ({ ok: true, text: async () => (typeof corps === 'string' ? corps : JSON.stringify(corps)) });
  const svcAvec = (fetchImpl: unknown, prisma: ReturnType<typeof makePrisma>, errorLogger = { record: jest.fn().mockResolvedValue('id') }) => {
    global.fetch = fetchImpl as typeof fetch;
    return { svc: new SpeedLimitService(prisma as never, errorLogger as never), errorLogger };
  };

  it('⚠️ `remark` sous un HTTP 200 : c’est une PANNE, rien n’est mémorisé', async () => {
    // La réponse exacte capturée le 2026-08-19 : HTTP 200, JSON valide, elements vide.
    const prisma = makePrisma();
    const { svc, errorLogger } = svcAvec(
      jest.fn().mockResolvedValue(reponse({ elements: [], remark: 'runtime error: Query timed out' })),
      prisma,
    );

    const resolver = await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]);

    expect(resolver(43.6, 1.44)).toBeNull();
    expect(prisma.speedLimitCache.create).not.toHaveBeenCalled(); // LE point : on retentera
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    expect(String(errorLogger.record.mock.calls[0][0])).toContain('Query timed out');
  });

  it('⚠️ page HTML sous un HTTP 200 (« server is probably too busy ») : rien n’est mémorisé', async () => {
    const prisma = makePrisma();
    const { svc } = svcAvec(
      jest.fn().mockResolvedValue(reponse('<html><body>Error: runtime error: ... too busy</body></html>')),
      prisma,
    );

    const resolver = await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]);

    expect(resolver(43.6, 1.44)).toBeNull();
    expect(prisma.speedLimitCache.create).not.toHaveBeenCalled();
  });

  it('⚠️ AUCUNE voie trouvée : suspect, donc NON mémorisé (l’ancien code le gravait)', async () => {
    // Un point GPS de véhicule en mouvement est sur une route par construction. Zéro voie à
    // 20 m est le symptôme d'une réponse dégradée, pas un fait de terrain.
    const prisma = makePrisma();
    const { svc, errorLogger } = svcAvec(jest.fn().mockResolvedValue(reponse({ elements: [] })), prisma);

    const resolver = await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]);

    expect(resolver(43.6, 1.44)).toBeNull();
    expect(prisma.speedLimitCache.create).not.toHaveBeenCalled();
    expect(errorLogger.record).not.toHaveBeenCalled(); // pas une panne : pas d'alerte parasite
  });

  it('échec transport (ECONNREFUSED) → UNE alerte tracée, rien mémorisé', async () => {
    const prisma = makePrisma();
    const { svc, errorLogger } = svcAvec(jest.fn().mockRejectedValue(new Error('ECONNREFUSED')), prisma);

    const resolver = await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]);

    expect(resolver(43.6, 1.44)).toBeNull();
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    const [, source, ctx] = errorLogger.record.mock.calls[0];
    expect(source).toBe('trip-analysis');
    expect(ctx).toMatchObject({ feature: 'speed-limit-osm' });
    expect(prisma.speedLimitCache.create).not.toHaveBeenCalled();
  });
});

describe('SpeedLimitService — résoudre pour de vrai', () => {
  const OLD_FETCH = global.fetch;
  afterEach(() => { global.fetch = OLD_FETCH; jest.restoreAllMocks(); });

  const makePrisma = () => ({
    speedLimitCache: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
  });
  const reponse = (corps: unknown) => ({ ok: true, text: async () => JSON.stringify(corps) });
  const voie = (lat: number, lng: number, tags: Record<string, string>) => ({
    type: 'way',
    tags,
    geometry: [{ lat, lon: lng - 0.0002 }, { lat, lon: lng + 0.0002 }],
  });
  const build = (elements: unknown[], prisma: ReturnType<typeof makePrisma>) => {
    global.fetch = jest.fn().mockResolvedValue(reponse({ elements })) as unknown as typeof fetch;
    return new SpeedLimitService(prisma as never, { record: jest.fn() } as never);
  };

  it('un maxspeed EXPLICITE prime et est mémorisé', async () => {
    const prisma = makePrisma();
    const svc = build([voie(43.6, 1.44, { highway: 'motorway_link', maxspeed: '70' })], prisma);

    const resolver = await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]);

    expect(resolver(43.6, 1.44)).toBe(70);
    expect(prisma.speedLimitCache.create).toHaveBeenCalledTimes(1);
    expect(prisma.speedLimitCache.create.mock.calls[0][0].data).toMatchObject({ maxspeed: 70 });
  });

  it('⚠️ sans tag maxspeed, le TYPE de voie donne la limite — c’est ce qui rattrape les 130/110/90', async () => {
    const prisma = makePrisma();
    const svc = build([voie(43.6, 1.44, { highway: 'motorway' })], prisma);

    const resolver = await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]);

    expect(resolver(43.6, 1.44)).toBe(130);
  });

  it('rattache CHAQUE point à SA route : deux points, deux limites', async () => {
    // C'est tout l'enjeu du groupement : une seule requête, mais pas une seule réponse.
    const prisma = makePrisma();
    const svc = build(
      [
        voie(43.6, 1.44, { highway: 'residential' }),
        voie(43.7, 1.5, { highway: 'motorway', maxspeed: '130' }),
      ],
      prisma,
    );

    const resolver = await svc.buildResolver([{ lat: 43.6, lng: 1.44 }, { lat: 43.7, lng: 1.5 }]);

    expect(resolver(43.6, 1.44)).toBe(50);
    expect(resolver(43.7, 1.5)).toBe(130);
  });

  it('ignore les voies NON routables : un trottoir ne fixe pas la limite d’une voiture', async () => {
    const prisma = makePrisma();
    const svc = build(
      [voie(43.6, 1.44, { highway: 'footway' }), voie(43.6, 1.44, { highway: 'primary' })],
      prisma,
    );

    expect((await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]))(43.6, 1.44)).toBe(90);
  });

  it('une voie trop LOIN du point n’est pas rattachée', async () => {
    const prisma = makePrisma();
    const svc = build([voie(43.9, 2.0, { highway: 'motorway' })], prisma);

    expect((await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]))(43.6, 1.44)).toBeNull();
  });

  it('⚠️ GROUPE les points : 45 points partent en 2 requêtes, pas 45 (ni 12 avec le reste perdu)', async () => {
    const prisma = makePrisma();
    const svc = build([], prisma);
    const points = Array.from({ length: 45 }, (_, i) => ({ lat: 43.6 + i * 0.001, lng: 1.44 }));

    await svc.buildResolver(points);

    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
  }, 10_000);

  it('le cache évite l’appel réseau', async () => {
    const prisma = makePrisma();
    prisma.speedLimitCache.findMany.mockResolvedValue([{ key: '43.6000,1.4400', maxspeed: 50 }]);
    const svc = build([], prisma);

    const resolver = await svc.buildResolver([{ lat: 43.6, lng: 1.44 }]);

    expect(resolver(43.6, 1.44)).toBe(50);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
