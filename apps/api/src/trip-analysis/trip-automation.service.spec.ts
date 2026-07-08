import { TripAutomationService } from './trip-automation.service';

/**
 * Automatisation des trajets — le pipeline « recalcul → analyse → récit », les bornes de coût,
 * le respect de l'IA coupée, et le skip quand désactivée. Instanciation manuelle + mocks (rapide,
 * déterministe, comme agenda-agent-runner.service.spec).
 */
describe('TripAutomationService', () => {
  function makeRow(over: Record<string, unknown> = {}) {
    return {
      id: 's1',
      enabled: true,
      frequency: 'hourly',
      hour: 2,
      lookbackHours: 26,
      recomputeTrips: true,
      narrateEnabled: true,
      maxAnalysesPerRun: 300,
      maxNarrationsPerRun: 60,
      lastRunAt: null,
      lastRunStats: null,
      updatedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
  }

  function build(opts: {
    row?: Record<string, unknown>;
    fleets?: { id: string }[];
    vehicles?: { id: string }[];
    dirty?: { startedAt: Date } | null;
    trips?: { id: string }[];
    analyses?: { tripId: string; narrative: string | null }[];
    aiEnabled?: boolean;
  }) {
    const row = makeRow(opts.row);
    const prisma = {
      tripAutomationSettings: {
        findFirst: jest.fn().mockResolvedValue(row),
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
      tripAutomationRun: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      fleet: { findMany: jest.fn().mockResolvedValue(opts.fleets ?? [{ id: 'f1', name: 'Flotte A' }]) },
      vehicle: { findMany: jest.fn().mockResolvedValue(opts.vehicles ?? [{ id: 'v1', plate: 'AA-001-BB' }]) },
      trip: {
        findFirst: jest.fn().mockResolvedValue(opts.dirty ?? null),
        findMany: jest.fn().mockResolvedValue((opts.trips ?? []).map((t) => ({ startedAt: new Date('2026-07-08T07:00:00Z'), ...t }))),
      },
      tripAnalysis: { findMany: jest.fn().mockResolvedValue(opts.analyses ?? []) },
    };
    const trips = { recompute: jest.fn().mockResolvedValue({ deleted: 0, created: 2 }) };
    const analysis = { analyze: jest.fn().mockResolvedValue({}) };
    const llm = { narrate: jest.fn().mockResolvedValue({}) };
    const aiAvail = { isEnabledForFleet: jest.fn().mockResolvedValue(opts.aiEnabled ?? true) };
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const systemActivity = { record: jest.fn() };
    const svc = new TripAutomationService(
      prisma as never,
      trips as never,
      analysis as never,
      llm as never,
      aiAvail as never,
      errorLogger as never,
      systemActivity as never,
    );
    return { svc, prisma, trips, analysis, llm, aiAvail, errorLogger, systemActivity };
  }

  it('ne fait rien quand désactivée (aucune itération de flotte)', async () => {
    const { svc, prisma } = build({ row: { enabled: false } });
    await svc.runScheduled();
    expect(prisma.fleet.findMany).not.toHaveBeenCalled();
  });

  it('pipeline : recompute le tail sale, analyse le trajet manquant, narre s’il manque le récit', async () => {
    const { svc, trips, analysis, llm, systemActivity } = build({
      dirty: { startedAt: new Date('2026-07-08T06:00:00Z') },
      trips: [{ id: 't1' }, { id: 't2' }],
      analyses: [{ tripId: 't1', narrative: 'déjà narré' }], // t1 complet, t2 vierge
      aiEnabled: true,
    });
    const stats = await svc.runNow();
    expect(trips.recompute).toHaveBeenCalledTimes(1); // tail sale → recompute
    expect(analysis.analyze).toHaveBeenCalledWith(expect.anything(), 't2'); // seul t2 manque
    expect(analysis.analyze).toHaveBeenCalledTimes(1);
    expect(llm.narrate).toHaveBeenCalledWith(expect.anything(), 't2'); // t2 sans récit
    expect(llm.narrate).toHaveBeenCalledTimes(1); // pas t1 (déjà narré)
    expect(stats.analyzed).toBe(1);
    expect(stats.narrated).toBe(1);
    expect(stats.recomputed).toBe(2);
    expect(systemActivity.record).toHaveBeenCalledTimes(1);
  });

  it('IA coupée pour la flotte : analyse OUI, récit NON', async () => {
    const { svc, analysis, llm } = build({
      trips: [{ id: 't2' }],
      analyses: [],
      aiEnabled: false,
    });
    const stats = await svc.runNow();
    expect(analysis.analyze).toHaveBeenCalledTimes(1); // déterministe non coupé
    expect(llm.narrate).not.toHaveBeenCalled(); // IA coupée
    expect(stats.narrated).toBe(0);
  });

  it('narrateEnabled=false : aucun récit même si l’IA est dispo', async () => {
    const { svc, llm } = build({
      row: { narrateEnabled: false },
      trips: [{ id: 't2' }],
      analyses: [],
      aiEnabled: true,
    });
    const stats = await svc.runNow();
    expect(llm.narrate).not.toHaveBeenCalled();
    expect(stats.narrated).toBe(0);
  });

  it('cap d’analyses respecté (0 → rien n’est analysé ni narré)', async () => {
    const { svc, analysis, llm } = build({
      row: { maxAnalysesPerRun: 0 },
      trips: [{ id: 't2' }],
      analyses: [],
      aiEnabled: true,
    });
    await svc.runNow();
    expect(analysis.analyze).not.toHaveBeenCalled();
    expect(llm.narrate).not.toHaveBeenCalled();
  });

  it('recomputeTrips=false : pas de recompute', async () => {
    const { svc, trips } = build({
      row: { recomputeTrips: false },
      dirty: { startedAt: new Date() },
      trips: [{ id: 't2' }],
      analyses: [],
    });
    await svc.runNow();
    expect(trips.recompute).not.toHaveBeenCalled();
  });

  it('enregistre le passage dans l’historique avec les récits produits (cliquables)', async () => {
    const { svc, prisma } = build({
      trips: [{ id: 't2' }],
      analyses: [],
      aiEnabled: true,
    });
    await svc.runNow();
    expect(prisma.tripAutomationRun.create).toHaveBeenCalledTimes(1);
    const data = prisma.tripAutomationRun.create.mock.calls[0][0].data;
    expect(data.origin).toBe('manual');
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({ vehicleId: 'v1', plate: 'AA-001-BB', tripId: 't2', action: 'narrated' });
    expect(data.finishedAt).toBeInstanceOf(Date);
  });

  it('setSettings clampe l’heure et normalise la fréquence', async () => {
    const { svc, prisma } = build({});
    await svc.setSettings({ hour: 99, frequency: 'weekly' as never }, 'u1');
    const data = prisma.tripAutomationSettings.update.mock.calls[0][0].data;
    expect(data.hour).toBe(23); // clampé 0-23
    expect(data.frequency).toBe('hourly'); // toute valeur ≠ 'daily' → 'hourly'
    expect(data.updatedByUserId).toBe('u1');
  });
});
