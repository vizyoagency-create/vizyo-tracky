import { TripAutomationService } from './trip-automation.service';

/**
 * Le RATTRAPAGE remonte jusqu'a l'horizon de retention — pas jusqu'a la fenetre du courant.
 *
 * ── LE BUG QUE CES TESTS VERROUILLENT ─────────────────────────────────────────────────
 *
 * Deux requetes du passage servent a resorber le retard : le front de recalcul (« le plus
 * vieux trajet encore brut ») et le complement « les plus anciens sans analyse ». Toutes deux
 * etaient bornees par `max(fenetre, horizon)`. Avec une fenetre de 1 500 h, ce max retombait
 * sur l'horizon et le rattrapage marchait. Le jour ou la fenetre est redescendue a 26 h, le
 * max a retombe sur la fenetre : le rattrapage cherchait de l'ancien... dans les 26 dernieres
 * heures, et n'en trouvait evidemment jamais.
 *
 * Mesure en production le 2026-09-02 : 784 trajets d'A2R sur 60 jours sans analyse, dont 310
 * jamais recalcules — donc jamais narrables — pendant que chaque passage horaire annoncait
 * « 8 analyses, 0 echec ». Le retard ne se resorbait pas ; il avait simplement cesse d'etre
 * visible.
 *
 * Les tests ne verifient pas un nombre magique mais la PROPRIETE : la borne basse du rattrapage
 * doit etre l'horizon (~59 jours), quelle que soit la fenetre reglee (ici 26 h). La liste du
 * COURANT, elle, reste bornee par la fenetre — c'est voulu, et le troisieme test le fige.
 */
describe('TripAutomationService — plancher du rattrapage', () => {
  const JOUR = 86_400_000;

  function build(lookbackHours: number) {
    const row = {
      id: 's1', enabled: true, frequency: 'hourly', hour: 2, lookbackHours,
      recomputeTrips: true, narrateEnabled: false, maxAnalysesPerRun: 300, maxNarrationsPerRun: 60,
      lastRunAt: null, lastRunStats: null, updatedByUserId: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const prisma = {
      tripAutomationSettings: {
        findFirst: jest.fn().mockResolvedValue(row),
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
      tripAutomationRun: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      fleet: { findMany: jest.fn().mockResolvedValue([{ id: 'f1', name: 'A2R' }]) },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([{ id: 'v1', plate: 'HD-779-MA', tracker: { id: 'tk1', lastSeenAt: new Date() } }]),
      },
      position: { count: jest.fn().mockResolvedValue(42), findMany: jest.fn().mockResolvedValue([]) },
      trip: {
        // Aucun trajet brut : le front n'a rien a recalculer, on ne teste ici que sa BORNE.
        findFirst: jest.fn().mockResolvedValue(null),
        // 1er appel = liste du courant ; 2e appel = complement « anciens sans analyse ».
        findMany: jest.fn().mockResolvedValue([]),
      },
      tripAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = new TripAutomationService(
      prisma as never,
      { recompute: jest.fn() } as never,
      { analyze: jest.fn() } as never,
      { narrate: jest.fn() } as never,
      { isEnabledForFleet: jest.fn().mockResolvedValue(false) } as never,
      { record: jest.fn().mockResolvedValue('id') } as never,
      { record: jest.fn() } as never,
    );
    return { svc, prisma };
  }

  const gteOf = (call: unknown): Date =>
    (call as { where: { startedAt: { gte: Date } } }).where.startedAt.gte;

  let retention: string | undefined;
  beforeEach(() => {
    retention = process.env.POSITIONS_RETENTION_DAYS;
    process.env.POSITIONS_RETENTION_DAYS = '60';
  });
  afterEach(() => {
    if (retention === undefined) delete process.env.POSITIONS_RETENTION_DAYS;
    else process.env.POSITIONS_RETENTION_DAYS = retention;
  });

  it('le front de recalcul remonte jusqu\'a l\'horizon (~59 j), meme avec une fenetre de 26 h', async () => {
    const { svc, prisma } = build(26);
    const avant = Date.now();
    await svc.runNow();

    expect(prisma.trip.findFirst).toHaveBeenCalledTimes(1);
    const gte = gteOf(prisma.trip.findFirst.mock.calls[0][0]);
    // ~59 jours en arriere (retention 60 j → horizon = now - 59 j), a la seconde pres.
    expect(avant - gte.getTime()).toBeGreaterThan(58 * JOUR);
    expect(avant - gte.getTime()).toBeLessThan(60 * JOUR);
  });

  it('le complement « anciens sans analyse » remonte lui aussi jusqu\'a l\'horizon', async () => {
    const { svc, prisma } = build(26);
    const avant = Date.now();
    await svc.runNow();

    // Deux listes de trajets : le courant, puis le complement.
    expect(prisma.trip.findMany).toHaveBeenCalledTimes(2);
    const gte = gteOf(prisma.trip.findMany.mock.calls[1][0]);
    expect(avant - gte.getTime()).toBeGreaterThan(58 * JOUR);
    expect(avant - gte.getTime()).toBeLessThan(60 * JOUR);
  });

  it('la liste du COURANT reste bornee par la fenetre (26 h) — le rattrapage ne l\'elargit pas', async () => {
    const { svc, prisma } = build(26);
    const avant = Date.now();
    await svc.runNow();

    const gte = gteOf(prisma.trip.findMany.mock.calls[0][0]);
    expect(avant - gte.getTime()).toBeGreaterThan(25 * 3_600_000);
    expect(avant - gte.getTime()).toBeLessThan(27 * 3_600_000);
  });

  it('retention desactivee (0) : le rattrapage retombe sur la fenetre, faute d\'horizon', async () => {
    process.env.POSITIONS_RETENTION_DAYS = '0';
    const { svc, prisma } = build(26);
    const avant = Date.now();
    await svc.runNow();

    const gte = gteOf(prisma.trip.findFirst.mock.calls[0][0]);
    expect(avant - gte.getTime()).toBeGreaterThan(25 * 3_600_000);
    expect(avant - gte.getTime()).toBeLessThan(27 * 3_600_000);
  });
});
