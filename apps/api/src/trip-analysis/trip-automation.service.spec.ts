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
    /** Positions présentes sur la tranche à recalculer (0 = tranche irrécupérable). */
    positions?: number;
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
      // Le boîtier est fourni par défaut : la vraie requête le joint (`tracker: { select: … }`), et
      // son id sert désormais à compter les positions de la tranche avant tout recalcul.
      vehicle: {
        findMany: jest
          .fn()
          .mockResolvedValue(opts.vehicles ?? [{ id: 'v1', plate: 'AA-001-BB', tracker: { id: 'tk1', lastSeenAt: new Date() } }]),
      },
      position: { count: jest.fn().mockResolvedValue(opts.positions ?? 42) },
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

  /**
   * BUDGET DE TEMPS — la garde posée AU BON ENDROIT.
   *
   * Première version : le budget n'était vérifié qu'à l'entrée de chaque VÉHICULE. Mesure de prod
   * du 19/08 : un passage à 31 minutes pour un plafond annoncé à 20. Le temps ne part pas dans le
   * nombre de véhicules, il part dans la boucle sur leurs TRAJETS — chaque analyse interroge
   * OpenStreetMap, chaque recalcul recale le tracé sur le réseau routier.
   */
  describe('budget de temps du passage', () => {
    afterEach(() => jest.restoreAllMocks());

    it('un seul véhicule chargé ne peut plus tenir le passage au-delà du budget', async () => {
      let horloge = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => horloge);
      const { svc, analysis } = build({
        trips: Array.from({ length: 40 }, (_, i) => ({ id: `t${i}` })),
        analyses: [],
        aiEnabled: false,
      });
      // Chaque analyse coûte 2 minutes : au bout de 10, le budget de 20 min est épuisé.
      analysis.analyze.mockImplementation(async () => {
        horloge += 2 * 60 * 1000;
      });

      const stats = await svc.runNow();

      expect(stats.budgetAtteint).toBe(true);
      // Sans la garde dans la boucle des trajets, les 40 y passaient — et le passage suivant
      // sautait, verrou `running` oblige.
      expect(analysis.analyze.mock.calls.length).toBeLessThan(40);
      expect(analysis.analyze.mock.calls.length).toBeGreaterThan(0);
    });

    it('un passage écourté le DIT dans le journal d\'activité', async () => {
      let horloge = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => horloge);
      const { svc, analysis, systemActivity } = build({
        trips: Array.from({ length: 40 }, (_, i) => ({ id: `t${i}` })),
        analyses: [],
        aiEnabled: false,
      });
      analysis.analyze.mockImplementation(async () => {
        horloge += 2 * 60 * 1000;
      });

      await svc.runNow();

      // « 10 analysés » ne doit pas pouvoir se lire comme « il n'y avait que 10 choses à faire ».
      const detail = systemActivity.record.mock.calls[0][0].detail as string;
      expect(detail).toMatch(/ÉCOURTÉ/);
    });

    it('un passage qui va au bout de son travail n\'est PAS marqué écourté', async () => {
      const { svc } = build({ trips: [{ id: 't1' }], analyses: [], aiEnabled: false });
      const stats = await svc.runNow();
      expect(stats.budgetAtteint).toBe(false);
    });
  });

  /**
   * TRANCHE BORNÉE (incident du 19/08). Un vieux trajet brut déclenchait un recalcul sur TOUTE la
   * fenêtre — 50 jours en prod : des heures de travail pendant lesquelles le verrou `running`
   * faisait sauter chaque passage horaire, puis un processus tué au redémarrage sans rien avoir
   * persisté. Le retard ne se résorbait jamais. Ce qui est verrouillé ici n'est donc pas « il
   * recompute » (c'était déjà vrai) mais « il ne recompute JAMAIS plus de 48 h d'un coup ».
   */
  describe('recalcul par tranches bornées', () => {
    const JOUR = 24 * 3600 * 1000;
    const amplitudeH = (call: { from: string; to: string }) =>
      (new Date(call.to).getTime() - new Date(call.from).getTime()) / 3_600_000;

    it('un retard de 40 jours ne déclenche qu’une tranche de 48 h', async () => {
      const vieuxTrajet = new Date(Date.now() - 40 * JOUR);
      const { svc, trips } = build({
        row: { lookbackHours: 1200 }, // 50 jours, la valeur de prod
        dirty: { startedAt: vieuxTrajet },
        trips: [],
        analyses: [],
      });
      await svc.runNow();
      expect(trips.recompute).toHaveBeenCalledTimes(1);
      const call = trips.recompute.mock.calls[0][1];
      expect(amplitudeH(call)).toBeCloseTo(48, 5);
      // Le front part du trajet brut (moins la marge amont), pas du début de la fenêtre : c'est ce
      // qui fait avancer la reprise d'un cran à chaque passage, sans rien mémoriser.
      expect(new Date(call.from).getTime()).toBe(vieuxTrajet.getTime() - 30 * 60 * 1000);
    });

    it('sur la queue fraîche, la borne haute reste la fin de fenêtre (comportement inchangé)', async () => {
      const { svc, trips } = build({
        row: { lookbackHours: 26 },
        dirty: { startedAt: new Date(Date.now() - 20 * 60 * 1000) },
        trips: [],
        analyses: [],
      });
      await svc.runNow();
      expect(amplitudeH(trips.recompute.mock.calls[0][1])).toBeLessThan(48);
    });

    it('tranche sans position : rien n’est supprimé, l’anomalie est comptée ET remontée', async () => {
      const { svc, trips, errorLogger } = build({
        row: { lookbackHours: 1200 },
        dirty: { startedAt: new Date(Date.now() - 40 * JOUR) },
        positions: 0,
        trips: [],
        analyses: [],
      });
      const stats = await svc.runNow();
      // recompute() SUPPRIME la tranche avant de la re-segmenter : sans position pour la
      // reconstruire, il détruirait un historique qu'il ne saurait pas recréer.
      expect(trips.recompute).not.toHaveBeenCalled();
      expect(stats.skippedNoPositions).toBe(1);
      // Le véhicule cale — mais BRUYAMMENT : un blocage visible vaut mieux qu'une perte silencieuse.
      expect(errorLogger.record).toHaveBeenCalledWith(
        expect.any(Error),
        'TRIP_AUTOMATION',
        expect.objectContaining({ phase: 'recompute:no-positions' }),
      );
    });
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
