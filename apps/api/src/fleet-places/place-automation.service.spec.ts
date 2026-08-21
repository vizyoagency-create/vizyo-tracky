import { PlaceAutomationService } from './place-automation.service';

/**
 * Automatisation des analyses de lieux. Ce service DÉPENSE DE L'ARGENT : la quasi-totalité des
 * tests ci-dessous vérifie qu'il **ne dépense pas**. La règle qui les résume : chaque garde-fou
 * doit couper AVANT l'appel payant, et on l'assert en vérifiant que `analyzeFromFacts` n'a pas
 * été appelé — pas seulement que le compteur affiche 0.
 */
describe('PlaceAutomationService', () => {
  const FLEETS = [
    { id: 'f1', name: 'A2R' },
    { id: 'f2', name: 'cdef31' },
  ];
  const placesOf = (fleetId: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${fleetId}-p${i}`, fleetId, name: `Lieu ${i}`, kind: 'FUEL_STATION',
      lat: 43.5, lng: 1.5, radiusM: 120, note: null, stationId: `st-${i}`,
    }));

  const DEFAULTS: {
    id: string; enabled: boolean; hour: number; minIntervalDays: number; skipUnchanged: boolean;
    maxAnalysesPerRun: number; maxCostEurPerRun: number; lastRunAt: Date | null; lastRunStats: unknown;
  } = {
    id: 'settings-1', enabled: true, hour: 3, minIntervalDays: 30, skipUnchanged: true,
    maxAnalysesPerRun: 20, maxCostEurPerRun: 1, lastRunAt: null, lastRunStats: null,
  };

  function build(over: {
    settings?: Partial<typeof DEFAULTS>;
    places?: Record<string, ReturnType<typeof placesOf>>;
    aiOn?: (fleetId: string) => boolean;
    existingAnalysis?: (placeId: string) => { computedAt: Date; factsHash: string | null } | null;
    budget?: { monthlyBudgetEur: number; spentThisMonthEur: number } | Error;
    costPerCall?: number;
    analyzeImpl?: jest.Mock;
  } = {}) {
    const settings = { ...DEFAULTS, ...over.settings };
    const places = over.places ?? { f1: placesOf('f1', 2), f2: placesOf('f2', 2) };

    const prisma = {
      fleet: { findMany: jest.fn().mockResolvedValue(FLEETS) },
      fleetPlace: {
        findMany: jest.fn().mockImplementation(({ where }) => Promise.resolve(places[where.fleetId] ?? [])),
        count: jest.fn().mockImplementation(({ where }) => Promise.resolve((places[where.fleetId] ?? []).length)),
      },
      placeAnalysis: {
        findUnique: jest.fn().mockImplementation(({ where }) =>
          Promise.resolve(over.existingAnalysis ? over.existingAnalysis(where.placeId) : null),
        ),
        aggregate: jest.fn().mockResolvedValue({ _avg: { costEur: 0.03 } }),
      },
      placeAutomationSettings: {
        findFirst: jest.fn().mockResolvedValue(settings),
        create: jest.fn().mockResolvedValue(settings),
        update: jest.fn().mockResolvedValue(settings),
      },
      placeAutomationRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    // Le contrôle de budget est DÉLÉGUÉ au service d'analyse (source unique, partagée avec le
    // déclenchement manuel) — on le mocke donc là où il vit réellement.
    const budgetExhausted = over.budget instanceof Error
      ? true
      : (over.budget?.monthlyBudgetEur ?? 0) > 0 && (over.budget?.spentThisMonthEur ?? 0) >= (over.budget?.monthlyBudgetEur ?? 0);
    const analysis = {
      gatherFacts: jest.fn().mockResolvedValue({ facts: { a: 1 }, hash: 'HASH_NEUF' }),
      analyzeFromFacts: over.analyzeImpl ?? jest.fn().mockResolvedValue({ analysis: {}, costEur: over.costPerCall ?? 0.02 }),
      // Bascule locale (design/C1) : le run ENFILE au lieu d'appeler le modele. `analyzeImpl`
      // des scenarios d'echec est rebranche ici — c'est l'enfilage qui echoue desormais.
      enfilerAnalyseLocale: over.analyzeImpl
        ? jest.fn().mockImplementation(async (...a: unknown[]) => { await over.analyzeImpl!(...a); return true; })
        : jest.fn().mockResolvedValue(true),
      consommerTravauxLocaux: jest.fn().mockResolvedValue({ ranges: 0, rejetes: 0 }),
      monthBudgetExhausted: jest.fn().mockResolvedValue(budgetExhausted),
    };
    const aiAvail = { isEnabledForFleet: jest.fn().mockImplementation((id: string) => Promise.resolve(over.aiOn ? over.aiOn(id) : true)) };
    const aiUsage = { getBudget: jest.fn().mockResolvedValue({ monthlyBudgetEur: 0, spentThisMonthEur: 0 }) };
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };

    const svc = new PlaceAutomationService(prisma as never, analysis as never, aiAvail as never, aiUsage as never, errorLogger as never);
    return { svc, prisma, analysis, aiAvail, aiUsage, errorLogger, settings };
  }

  const parisHour = () =>
    Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date()));

  beforeEach(() => jest.clearAllMocks());

  // ─── Garde-fou 1 : opt-in ────────────────────────────────────────────────
  it('DÉSACTIVÉ par défaut : le cron ne dépense rien', async () => {
    const { svc, analysis, prisma } = build({ settings: { enabled: false } });
    await svc.runScheduled();
    expect(analysis.gatherFacts).not.toHaveBeenCalled();
    expect(analysis.enfilerAnalyseLocale).not.toHaveBeenCalled();
    expect(prisma.placeAutomationRun.create).not.toHaveBeenCalled();
  });

  it("ne fait rien en dehors de l'heure configurée", async () => {
    const { svc, analysis } = build({ settings: { hour: (parisHour() + 5) % 24 } });
    await svc.runScheduled();
    expect(analysis.enfilerAnalyseLocale).not.toHaveBeenCalled();
  });

  it('refuse un second run dans les 22 h (anti double-run)', async () => {
    const { svc, analysis } = build({ settings: { hour: parisHour(), lastRunAt: new Date() } });
    await svc.runScheduled();
    expect(analysis.enfilerAnalyseLocale).not.toHaveBeenCalled();
  });

  // ─── Garde-fou 2 : société sans IA ───────────────────────────────────────
  it("écarte en bloc une société dont l'IA est coupée, sans même collecter ses faits", async () => {
    const { svc, analysis } = build({ aiOn: (id) => id === 'f1' });

    const stats = await svc.runNow();

    expect(stats.skippedAiOff).toBe(2); // les 2 lieux de f2
    expect(stats.analyzed).toBe(2); // seulement ceux de f1
    // La collecte (gratuite mais lente) n'est même pas tentée pour la société coupée.
    expect(analysis.gatherFacts).toHaveBeenCalledTimes(2);
    for (const call of analysis.enfilerAnalyseLocale.mock.calls) expect(call[0].fleetId).toBe('f1');
  });

  // ─── Garde-fou 3 : budget mensuel ────────────────────────────────────────
  it('ANNULE le run quand le budget IA du mois est atteint — aucun appel émis', async () => {
    const { svc, analysis } = build({ budget: { monthlyBudgetEur: 10, spentThisMonthEur: 10 } });

    const stats = await svc.runNow();

    expect(stats.stopReason).toBe('month_budget');
    expect(stats.analyzed).toBe(0);
    expect(analysis.gatherFacts).not.toHaveBeenCalled();
    expect(analysis.enfilerAnalyseLocale).not.toHaveBeenCalled();
  });

  it('budget illisible ⇒ fail-CLOSED : on ne dépense pas dans le doute', async () => {
    // (le fail-closed lui-même est testé côté PlaceAnalysisService, qui porte le contrôle unique)
    const { svc, analysis } = build({ budget: new Error('DB down') });

    const stats = await svc.runNow();

    expect(stats.stopReason).toBe('month_budget');
    expect(analysis.enfilerAnalyseLocale).not.toHaveBeenCalled();
  });

  it('budget non défini (0) = pas de plafond, le run se fait', async () => {
    const { svc, analysis } = build({ budget: { monthlyBudgetEur: 0, spentThisMonthEur: 999 } });
    const stats = await svc.runNow();
    expect(stats.analyzed).toBe(4);
    expect(analysis.enfilerAnalyseLocale).toHaveBeenCalledTimes(4);
  });

  // ─── Garde-fou 4 : délai minimum par lieu ────────────────────────────────
  it('saute un lieu analysé récemment SANS même collecter ses faits (délai minimum)', async () => {
    const { svc, analysis } = build({
      existingAnalysis: () => ({ computedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000), factsHash: 'X' }),
    });

    const stats = await svc.runNow();

    expect(stats.skippedCooldown).toBe(4);
    expect(stats.analyzed).toBe(0);
    expect(analysis.gatherFacts).not.toHaveBeenCalled();
    expect(analysis.enfilerAnalyseLocale).not.toHaveBeenCalled();
  });

  it('ré-analyse une fois le délai minimum écoulé', async () => {
    const { svc, analysis } = build({
      existingAnalysis: () => ({ computedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000), factsHash: 'ANCIEN' }),
    });
    const stats = await svc.runNow();
    expect(stats.analyzed).toBe(4);
    expect(analysis.enfilerAnalyseLocale).toHaveBeenCalledTimes(4);
  });

  // ─── Garde-fou 5 : empreinte des faits ───────────────────────────────────
  it('ne repaie PAS quand les faits sont inchangés (même empreinte)', async () => {
    const { svc, analysis } = build({
      existingAnalysis: () => ({ computedAt: new Date(Date.now() - 60 * 24 * 3600 * 1000), factsHash: 'HASH_NEUF' }),
    });

    const stats = await svc.runNow();

    expect(stats.skippedUnchanged).toBe(4);
    expect(stats.analyzed).toBe(0);
    expect(analysis.gatherFacts).toHaveBeenCalledTimes(4); // collecte gratuite : normale
    expect(analysis.enfilerAnalyseLocale).not.toHaveBeenCalled(); // appel payant : jamais
  });

  it('analyse quand même si l\'ancienne analyse n\'a pas d\'empreinte (antérieure au dispositif)', async () => {
    const { svc, analysis } = build({
      existingAnalysis: () => ({ computedAt: new Date(Date.now() - 60 * 24 * 3600 * 1000), factsHash: null }),
    });
    const stats = await svc.runNow();
    expect(stats.skippedUnchanged).toBe(0);
    expect(analysis.enfilerAnalyseLocale).toHaveBeenCalledTimes(4);
  });

  it('respecte le réglage skipUnchanged=false (re-analyse même si rien n\'a bougé)', async () => {
    const { svc, analysis } = build({
      settings: { skipUnchanged: false },
      existingAnalysis: () => ({ computedAt: new Date(Date.now() - 60 * 24 * 3600 * 1000), factsHash: 'HASH_NEUF' }),
    });
    const stats = await svc.runNow();
    expect(stats.analyzed).toBe(4);
    expect(analysis.enfilerAnalyseLocale).toHaveBeenCalledTimes(4);
  });

  // ─── Plafonds durs ───────────────────────────────────────────────────────
  it('s\'arrête au plafond de NOMBRE d\'analyses par run', async () => {
    const { svc, analysis } = build({
      settings: { maxAnalysesPerRun: 3 },
      places: { f1: placesOf('f1', 10), f2: [] },
    });

    const stats = await svc.runNow();

    expect(stats.analyzed).toBe(3);
    expect(stats.stopReason).toBe('max_analyses');
    expect(analysis.enfilerAnalyseLocale).toHaveBeenCalledTimes(3);
  });

  it('⚠️ le plafond de DÉPENSE ne mord plus : la voie locale coûte zéro (design/C1)', async () => {
    // Bascule du 2026-08-21 : le run ENFILE pour le poste au lieu d'appeler le modele. Meme
    // avec un plafond minuscule, tous les lieux dus partent en file — la depense reste 0.
    // Le plafond est CONSERVE dans les reglages pour le jour ou la voie API reviendrait.
    const { svc, analysis } = build({
      settings: { maxCostEurPerRun: 0.1, maxAnalysesPerRun: 100 },
      places: { f1: placesOf('f1', 20), f2: [] },
      costPerCall: 0.04,
    });

    const stats = await svc.runNow();

    expect(analysis.enfilerAnalyseLocale).toHaveBeenCalledTimes(20); // TOUS les lieux dus, plus 3
    expect(stats.stopReason).not.toBe('max_cost');
    expect(stats.costEur).toBe(0);
  });

  // ─── Robustesse ──────────────────────────────────────────────────────────
  it('un lieu en échec est compté et remonté au centre d\'alerte, sans casser le run', async () => {
    const analyzeImpl = jest.fn()
      .mockRejectedValueOnce(new Error('provider 503'))
      .mockResolvedValue({ analysis: {}, costEur: 0.02 });
    const { svc, errorLogger } = build({ analyzeImpl });

    const stats = await svc.runNow();

    expect(stats.failed).toBe(1);
    expect(stats.analyzed).toBe(3); // les 3 autres passent
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.any(Error), 'PLACE_AUTOMATION',
      expect.objectContaining({ phase: 'analyze', placeId: 'f1-p0' }), 'ERROR',
    );
  });

  it('⚠️ un enfilage en échec n\'ajoute AUCUNE dépense : rien n\'a été payé (design/C1)', async () => {
    // L'ancien monde devait compter « paye puis echoue » (l'IA avait repondu, la base non).
    // Sur la voie locale, l'echec survient AVANT tout appel modele : la depense reste nulle,
    // et l'echec reste compte + remonte — un lieu qui echoue ne disparait pas en silence.
    const paid = Object.assign(new Error('enfilage failed'), { paidCostEur: 0.03 });
    const analyzeImpl = jest.fn().mockRejectedValueOnce(paid).mockResolvedValue({ analysis: {}, costEur: 0.02 });
    const { svc, errorLogger } = build({ analyzeImpl });

    const stats = await svc.runNow();

    expect(stats.failed).toBe(1);
    expect(stats.costEur).toBeCloseTo(0.03, 4); // seul le paidCostEur herite est conserve par prudence
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.any(Error), 'PLACE_AUTOMATION', expect.objectContaining({ phase: 'analyze' }), 'ERROR',
    );
  });

  it('une panne en série coupe le run au lieu de payer tous les lieux (coupe-circuit)', async () => {
    // Panne systématique APRÈS facturation : sans coupe-circuit, le run paierait chaque lieu.
    const analyzeImpl = jest.fn().mockImplementation(() =>
      Promise.reject(Object.assign(new Error('DB down'), { paidCostEur: 0.02 })),
    );
    const { svc } = build({ analyzeImpl, places: { f1: placesOf('f1', 50), f2: [] } });

    const stats = await svc.runNow();

    expect(stats.stopReason).toBe('too_many_failures');
    expect(stats.failed).toBe(3); // arrêt au 3e échec consécutif, pas au 50e
    expect(stats.costEur).toBeCloseTo(0.06, 4);
  });

  it('un succès remet le compteur d\'échecs consécutifs à zéro', async () => {
    const analyzeImpl = jest.fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ analysis: {}, costEur: 0.02 })
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue({ analysis: {}, costEur: 0.02 });
    const { svc } = build({ analyzeImpl });

    const stats = await svc.runNow();

    expect(stats.stopReason).toBe('completed'); // 2 échecs non consécutifs : le run va au bout
    expect(stats.failed).toBe(2);
    expect(stats.analyzed).toBe(2);
  });

  it('ne lève JAMAIS, même si la base est cassée (le cron doit survivre)', async () => {
    const { svc, prisma, errorLogger } = build();
    prisma.fleet.findMany.mockRejectedValue(new Error('DB down'));

    const stats = await svc.runNow();

    expect(stats.stopReason).toBe('error');
    expect(errorLogger.record).toHaveBeenCalledWith(expect.any(Error), 'PLACE_AUTOMATION', expect.objectContaining({ phase: 'run' }), 'CRITICAL');
  });

  it('refuse deux runs simultanés (verrou anti-chevauchement)', async () => {
    let release: (v: unknown) => void = () => {};
    let markStarted: () => void = () => {};
    // On attend que le 1er run ait RÉELLEMENT pris le verrou (il traverse plusieurs await avant).
    const firstStarted = new Promise<void>((r) => { markStarted = r; });
    const analyzeImpl = jest.fn()
      .mockImplementationOnce(() => { markStarted(); return new Promise((r) => { release = r; }); })
      .mockResolvedValue({ analysis: {}, costEur: 0.02 });
    const { svc, analysis } = build({ analyzeImpl });

    const first = svc.runNow();
    await firstStarted;
    const second = await svc.runNow(); // doit être refusé sans rien faire

    // Motif DISTINCT de « terminé » : l'UI ne doit pas afficher un succès vert alors qu'un autre
    // passage est en train de dépenser en arrière-plan.
    expect(second.stopReason).toBe('already_running');
    expect(second.analyzed).toBe(0);
    expect(analysis.enfilerAnalyseLocale).toHaveBeenCalledTimes(1); // le 2e n'a rien déclenché

    release({ analysis: {}, costEur: 0.02 });
    await first;
    expect(analysis.enfilerAnalyseLocale).toHaveBeenCalledTimes(4); // le 1er run finit ses 4 lieux
  });

  // ─── Simulation ──────────────────────────────────────────────────────────
  it('la SIMULATION chiffre le run sans émettre un seul appel payant', async () => {
    const { svc, analysis, prisma } = build();

    const stats = await svc.runNow(true);

    expect(stats.dryRun).toBe(true);
    expect(stats.analyzed).toBe(4);
    expect(stats.costEur).toBeCloseTo(0.12, 4); // 4 × coût moyen observé (0.03)
    expect(analysis.enfilerAnalyseLocale).not.toHaveBeenCalled();
    // Une simulation ne décale pas la cadence réelle.
    expect(prisma.placeAutomationSettings.update).not.toHaveBeenCalled();
  });

  // ─── Traçabilité ─────────────────────────────────────────────────────────
  it('persiste le run avec le détail des sauts par motif (« pourquoi ça a coûté ça »)', async () => {
    const { svc, prisma } = build({ aiOn: (id) => id === 'f1' });

    await svc.runNow();

    expect(prisma.placeAutomationRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          origin: 'manual', analyzed: 2, skippedAiOff: 2, failed: 0, stopReason: 'completed',
          costEur: expect.any(Number), items: expect.any(Array),
        }),
      }),
    );
  });

  // ─── Réglages ────────────────────────────────────────────────────────────
  it('CLAMPE des réglages absurdes (impossible d\'armer une dépense folle depuis l\'UI)', async () => {
    const { svc, prisma } = build();

    await svc.setSettings({ hour: 99, minIntervalDays: 0, maxAnalysesPerRun: 99999, maxCostEurPerRun: 10000 }, 'u1');

    expect(prisma.placeAutomationSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        // maxCostEurPerRun est plafonné à 5 € — DÉLIBÉRÉMENT bas : × 30 jours, c'est lui qui
        // détermine le pire cas mensuel (5 €/jour = 150 €/mois).
        data: expect.objectContaining({ hour: 23, minIntervalDays: 1, maxAnalysesPerRun: 200, maxCostEurPerRun: 5 }),
      }),
    );
  });

  it('ignore les champs absents au lieu de les écraser', async () => {
    const { svc, prisma } = build();
    await svc.setSettings({ enabled: true }, 'u1');
    const data = prisma.placeAutomationSettings.update.mock.calls[0]![0].data;
    expect(data).toEqual({ enabled: true, updatedByUserId: 'u1' });
  });
});
