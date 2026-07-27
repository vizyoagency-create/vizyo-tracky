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
    vehicles?: Record<string, unknown>[];
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

  /**
   * DORMANCE (72 h — seuil « arrêter d'agir »). En prod, 2 véhicules sur 39 sont muets depuis 52 et
   * 89 jours : le cron horaire relançait pour eux recompute + listing + lecture des analyses, pour
   * un résultat toujours vide. On vérifie ici l'exclusion ET, surtout, ses limites — c'est la
   * frontière qui compte, pas le cas facile.
   */
  describe('dormance : on n’agit plus sur un boîtier muet', () => {
    const H = 3600 * 1000;
    /** Véhicule + boîtier entendu il y a `ms` (null = boîtier qui n'a jamais émis). */
    const withTracker = (ms: number | null) => [
      { id: 'v1', plate: 'AA-001-BB', tracker: { id: 'tk1', lastSeenAt: ms == null ? null : new Date(Date.now() - ms) } },
    ];

    it('exclut le véhicule muet depuis 89 j : AUCUNE requête trajets, aucun appel IA', async () => {
      const { svc, prisma, trips, analysis, llm } = build({
        vehicles: withTracker(89 * 24 * H),
        dirty: { startedAt: new Date() },
        trips: [{ id: 't2' }],
        analyses: [],
        aiEnabled: true,
      });
      const stats = await svc.runNow();
      expect(trips.recompute).not.toHaveBeenCalled();
      expect(prisma.trip.findMany).not.toHaveBeenCalled(); // le travail pour rien a bien disparu
      expect(analysis.analyze).not.toHaveBeenCalled();
      expect(llm.narrate).not.toHaveBeenCalled();
      // L'exclusion est COMPTÉE : `vehicles` baisse, mais jamais en silence.
      expect(stats.skippedDormant).toBe(1);
      expect(stats.vehicles).toBe(0);
    });

    it('un silence de 2 h n’exclut PAS (un véhicule garé se tait aussi)', async () => {
      const { svc, analysis } = build({
        vehicles: withTracker(2 * H),
        trips: [{ id: 't2' }],
        analyses: [],
      });
      const stats = await svc.runNow();
      expect(analysis.analyze).toHaveBeenCalledTimes(1);
      expect(stats.skippedDormant).toBe(0);
      expect(stats.vehicles).toBe(1);
    });

    it('boîtier qui n’a JAMAIS émis : pas dormant (« jamais connecté » ≠ « s’est tu »)', async () => {
      const { svc, prisma } = build({ vehicles: withTracker(null), trips: [], analyses: [] });
      const stats = await svc.runNow();
      expect(prisma.trip.findMany).toHaveBeenCalled(); // il traverse le pipeline, sans rien y trouver
      expect(stats.skippedDormant).toBe(0);
    });

    it('véhicule sans boîtier du tout : pas dormant non plus', async () => {
      const { svc, analysis } = build({
        vehicles: [{ id: 'v9', plate: 'TEST-001-XX', tracker: null }],
        trips: [{ id: 't2' }],
        analyses: [],
      });
      const stats = await svc.runNow();
      expect(stats.skippedDormant).toBe(0);
      expect(analysis.analyze).toHaveBeenCalledTimes(1);
    });

    it('réintégration automatique dès que le boîtier reparle (aucun bouton, aucun drapeau)', async () => {
      const dormant = build({ vehicles: withTracker(80 * H), trips: [{ id: 't2' }], analyses: [] });
      expect((await dormant.svc.runNow()).skippedDormant).toBe(1);

      // Même véhicule, une trame reçue il y a 1 min : il revient dans le pipeline au passage suivant.
      const revenu = build({ vehicles: withTracker(60_000), trips: [{ id: 't2' }], analyses: [] });
      const stats = await revenu.svc.runNow();
      expect(stats.skippedDormant).toBe(0);
      expect(revenu.analysis.analyze).toHaveBeenCalledWith(expect.anything(), 't2');
    });

    it('le journal d’activité ANNONCE les véhicules ignorés (chiffre qui baisse = chiffre expliqué)', async () => {
      const { svc, systemActivity } = build({ vehicles: withTracker(89 * 24 * H), trips: [], analyses: [] });
      await svc.runNow();
      const rec = systemActivity.record.mock.calls[0][0];
      expect(rec.detail).toContain('1 véhicule(s) au boîtier muet ignoré(s)');
      expect(rec.meta.skippedDormant).toBe(1);
    });
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
