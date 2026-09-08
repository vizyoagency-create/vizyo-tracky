import { TripAutomationService } from './trip-automation.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA LIGNE AU DÉPART — UN PASSAGE TUÉ EN VOL NE DISPARAÎT PLUS SANS TRACE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Demande du propriétaire (2026-09-08). Mesuré la veille : quatre passages horaires disparus
 * (14:45, 15:45, 17:45, 23:45 UTC), chacun tué par la recréation du conteneur pendant qu'il
 * tournait — et aucune trace nulle part, parce que la ligne d'historique n'était écrite qu'à
 * la CLÔTURE. Un passage dure de 2 à 54 min : la fenêtre à risque est large, et invisible.
 *
 * Ce qui est protégé ici :
 *  1. la ligne est écrite AVANT de toucher à une flotte, en `running` ;
 *  2. à la clôture c'est la MÊME ligne qui est complétée (pas une seconde) ;
 *  3. au redémarrage, une ligne restée `running` est marquée `interrupted`, inscrite au journal
 *     et remontée en CRITICAL — la vigie des critiques la met dans un e-mail ;
 *  4. sans ligne orpheline, le redémarrage n'écrit rien ;
 *  5. si la ligne de départ ne peut pas s'écrire, le passage tourne et la clôture la crée ;
 *  6. un passage arrêté sur une exception ferme sa ligne en `failed`, jamais laissée `running`.
 */
describe('TripAutomationService — la ligne au départ', () => {
  function makeRow(over: Record<string, unknown> = {}) {
    return {
      id: 's1', enabled: true, frequency: 'hourly', hour: 2, lookbackHours: 26,
      recomputeTrips: false, narrateEnabled: false, maxAnalysesPerRun: 300,
      maxNarrationsPerRun: 60, lastRunAt: null, lastRunStats: null,
      updatedByUserId: null, createdAt: new Date(), updatedAt: new Date(),
      ...over,
    };
  }

  /** Même harnais que garde-double-run.spec, plus un journal d'ORDRE des appels et les lignes orphelines. */
  function build(opts: {
    orphelins?: { id: string; startedAt: Date; origin: string }[];
    departIllisible?: boolean;
    flottesEnPanne?: boolean;
  } = {}) {
    const ordre: string[] = [];
    const row = makeRow();
    const prisma = {
      tripAutomationSettings: {
        findFirst: jest.fn().mockResolvedValue(row),
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
      tripAutomationRun: {
        create: jest.fn().mockImplementation(async (args: { data: { status?: string } }) => {
          ordre.push(`create:${args.data.status ?? '?'}`);
          if (opts.departIllisible && args.data.status === 'running') throw new Error('base injoignable');
          return { id: 'ligne-1' };
        }),
        update: jest.fn().mockImplementation(async (args: { data: { status?: string } }) => {
          ordre.push(`update:${args.data.status ?? '?'}`);
          return {};
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockImplementation(async (args?: { where?: { status?: string } }) =>
          args?.where?.status === 'running' ? (opts.orphelins ?? []) : [],
        ),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      fleet: {
        findMany: jest.fn().mockImplementation(async () => {
          ordre.push('fleets');
          if (opts.flottesEnPanne) throw new Error('flottes illisibles');
          return [{ id: 'f1', name: 'Flotte test' }];
        }),
      },
      vehicle: { findMany: jest.fn().mockResolvedValue([]) },
      position: { count: jest.fn().mockResolvedValue(0) },
      trip: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      tripAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const systemActivity = { record: jest.fn() };
    const svc = new TripAutomationService(
      prisma as never,
      { recompute: jest.fn() } as never,
      { analyze: jest.fn() } as never,
      { narrate: jest.fn() } as never,
      { isEnabledForFleet: jest.fn().mockResolvedValue(true) } as never,
      errorLogger as never,
      systemActivity as never,
    );
    return { svc, prisma, errorLogger, systemActivity, ordre };
  }

  const ilYA = (min: number) => new Date(Date.now() - min * 60_000);

  it('🔴 la ligne est écrite AVANT de toucher à une flotte, en « running », sans fin', async () => {
    const { svc, prisma, ordre } = build();

    await svc.runNow();

    expect(prisma.tripAutomationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'running', finishedAt: null, origin: 'manual', startedAt: expect.any(Date) }),
      }),
    );
    expect(ordre.indexOf('create:running')).toBeLessThan(ordre.indexOf('fleets'));
  });

  it('🔴 à la clôture, c\'est la MÊME ligne qui est complétée — pas une seconde', async () => {
    const { svc, prisma, ordre } = build();

    await svc.runNow();

    expect(prisma.tripAutomationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ligne-1' },
        data: expect.objectContaining({ status: 'done', finishedAt: expect.any(Date), fleets: 1, durationMs: expect.any(Number) }),
      }),
    );
    expect(prisma.tripAutomationRun.create).toHaveBeenCalledTimes(1);
    expect(ordre).toEqual(['create:running', 'fleets', 'update:done']);
  });

  it('🔴 au redémarrage, une ligne restée « running » est marquée interrompue et remontée en CRITICAL', async () => {
    const { svc, prisma, errorLogger, systemActivity } = build({
      orphelins: [{ id: 'mort-1', startedAt: ilYA(12), origin: 'scheduled' }],
    });

    const n = await svc.onApplicationBootstrap().then(() => svc.marquerPassagesInterrompus());

    // Deux appels (bootstrap + explicite) : le marquage est idempotent côté base — ici on vérifie l'effet.
    expect(n).toBe(1);
    expect(prisma.tripAutomationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['mort-1'] } }, data: { status: 'interrupted' } }),
    );
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.stringContaining('interrompu'),
      'TRIP_AUTOMATION',
      expect.objectContaining({ phase: 'interrompu', runId: 'mort-1', origin: 'scheduled' }),
      'CRITICAL',
    );
    expect(systemActivity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trip_automation_passage_interrompu', status: 'FAILURE' }),
    );
  });

  it('le message dit quand le passage a commencé et combien de temps après l\'API a redémarré', async () => {
    const { svc, errorLogger } = build({
      orphelins: [{ id: 'mort-2', startedAt: ilYA(12), origin: 'manual' }],
    });

    await svc.marquerPassagesInterrompus();

    const message = errorLogger.record.mock.calls[0][0] as string;
    expect(message).toMatch(/commencé le \d{2}\/\d{2}\/\d{4}/);
    expect(message).toContain('(manuel)');
    expect(message).toMatch(/redémarré 1[12] min plus tard/);
    expect(message).toContain('prochain passage');
  });

  it('sans ligne orpheline, le redémarrage n\'écrit rien nulle part', async () => {
    const { svc, prisma, errorLogger, systemActivity } = build();

    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(prisma.tripAutomationRun.updateMany).not.toHaveBeenCalled();
    expect(errorLogger.record).not.toHaveBeenCalled();
    expect(systemActivity.record).not.toHaveBeenCalled();
  });

  it('historique illisible au démarrage : on le dit dans le journal, et rien ne lève', async () => {
    const { svc, prisma } = build();
    prisma.tripAutomationRun.findMany.mockRejectedValueOnce(new Error('table illisible'));

    await expect(svc.marquerPassagesInterrompus()).resolves.toBe(0);
  });

  it('si la ligne de départ ne peut pas s\'écrire, le passage tourne quand même et la clôture la crée', async () => {
    const { svc, prisma, errorLogger, ordre } = build({ departIllisible: true });

    await svc.runNow();

    expect(ordre).toEqual(['create:running', 'fleets', 'create:done']);
    expect(prisma.tripAutomationRun.update).not.toHaveBeenCalled();
    // L'échec du départ est consigné, mais comme une erreur ordinaire : rien n'est en panne côté passage.
    expect(errorLogger.record).toHaveBeenCalledWith(expect.any(Error), 'TRIP_AUTOMATION', expect.objectContaining({ phase: 'ouvrirLigne' }));
    expect(errorLogger.record).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'CRITICAL');
  });

  it('un passage arrêté sur une exception ferme sa ligne en « failed » — jamais laissée « running »', async () => {
    const { svc, prisma, ordre } = build({ flottesEnPanne: true });

    await svc.runNow();

    expect(prisma.tripAutomationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ligne-1' }, data: expect.objectContaining({ status: 'failed', finishedAt: expect.any(Date) }) }),
    );
    expect(ordre).toEqual(['create:running', 'fleets', 'update:failed']);
  });

  it('si la ligne ouverte a disparu entre-temps, la clôture la recrée : l\'audit ne se perd pas', async () => {
    const { svc, prisma, ordre } = build();
    prisma.tripAutomationRun.update.mockRejectedValueOnce(new Error('P2025 : ligne introuvable'));

    await svc.runNow();

    expect(ordre).toEqual(['create:running', 'fleets', 'create:done']);
  });

  it('le DTO expose l\'état ; une valeur inconnue se lit « done »', async () => {
    const { svc, prisma } = build();
    const base = {
      id: 'r', startedAt: new Date(), finishedAt: null, origin: 'scheduled', fleets: 0, vehicles: 0,
      recomputed: 0, analyzed: 0, narrated: 0, failed: 0, durationMs: 0, items: [],
    };
    prisma.tripAutomationRun.findMany.mockResolvedValueOnce([
      { ...base, id: 'a', status: 'interrupted' },
      { ...base, id: 'b', status: 'running' },
      { ...base, id: 'c', status: 'n-importe-quoi' },
    ]);

    const dtos = await svc.listRuns(3);

    expect(dtos.map((d) => d.status)).toEqual(['interrupted', 'running', 'done']);
  });
});
