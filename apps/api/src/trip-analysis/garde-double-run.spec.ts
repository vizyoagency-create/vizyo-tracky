import { TripAutomationService } from './trip-automation.service';

/**
 * TRK-043 — la garde anti double-run mesurée depuis le DÉPART, pas depuis la fin.
 *
 * Le défaut mesuré (2026-08-23) : la garde comparait le tick horaire à `lastRunAt`, écrit à
 * la CLÔTURE du passage précédent. Tout passage de plus de 10 min emportait donc le tick
 * suivant — **14 passages sur 24** pour une cadence déclarée horaire — et un passage à budget
 * plein (50 min) GARANTISSAIT l'annulation du suivant : *le frein serrait le plus fort
 * exactement quand la charge montait*.
 *
 * ⚠️ AUCUN test ne verrouillait la garde d'avant — rien n'a cassé en la corrigeant. La seule
 * preuve que ce lot corrige quelque chose est le premier test ci-dessous : il a été écrit
 * AVANT le correctif et VÉRIFIÉ EN ÉCHEC sur l'ancien code (la garde fin-based annulait).
 */
describe('TripAutomationService — garde anti double-run depuis le DÉPART (TRK-043)', () => {
  function makeRow(over: Record<string, unknown> = {}) {
    return {
      id: 's1', enabled: true, frequency: 'hourly', hour: 2, lookbackHours: 26,
      recomputeTrips: false, narrateEnabled: false, maxAnalysesPerRun: 300,
      maxNarrationsPerRun: 60, lastRunAt: null, lastRunStats: null,
      updatedByUserId: null, createdAt: new Date(), updatedAt: new Date(),
      ...over,
    };
  }

  /**
   * Builder : copie du harnais de trip-automation.service.spec, plus `dernierDepart` branché
   * sur `tripAutomationRun.findFirst` — le point de mesure que la garde relit désormais.
   * Chaque `build()` est un conteneur RECRÉÉ : `this.running` y est frais, exprès (test n°3).
   */
  function build(opts: {
    row?: Record<string, unknown>;
    /** Départ du dernier passage persisté ; null = historique vide ; 'illisible' = table en panne. */
    dernierDepart?: Date | null | 'illisible';
  }) {
    const row = makeRow(opts.row);
    const findFirstRun =
      opts.dernierDepart === 'illisible'
        ? jest.fn().mockRejectedValue(new Error('table illisible'))
        : jest.fn().mockResolvedValue(opts.dernierDepart ? { startedAt: opts.dernierDepart } : null);
    const prisma = {
      tripAutomationSettings: {
        findFirst: jest.fn().mockResolvedValue(row),
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
      tripAutomationRun: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: findFirstRun,
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      fleet: { findMany: jest.fn().mockResolvedValue([]) },
      vehicle: { findMany: jest.fn().mockResolvedValue([]) },
      position: { count: jest.fn().mockResolvedValue(0) },
      trip: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      tripAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const systemActivity = { record: jest.fn() };
    const svc = new TripAutomationService(
      prisma as never,
      { recompute: jest.fn() } as never,
      { analyze: jest.fn() } as never,
      { narrate: jest.fn() } as never,
      { isEnabledForFleet: jest.fn().mockResolvedValue(true) } as never,
      { record: jest.fn().mockResolvedValue('id') } as never,
      systemActivity as never,
    );
    return { svc, prisma, systemActivity };
  }

  const ilYA = (min: number) => new Date(Date.now() - min * 60_000);

  it('🔴 LE CAS RÉEL : parti il y a 60 min, fini il y a 10 min → le tick PART', async () => {
    // C'est exactement le motif qui divisait la cadence par deux : départ :45, fin :35 de
    // l'heure d'après, tick à :45 → 10 min d'écart FIN-based, annulé. Départ-based : 60 min.
    const { svc, prisma } = build({
      row: { lastRunAt: ilYA(10) },
      dernierDepart: ilYA(60),
    });
    await svc.runScheduled();
    expect(prisma.fleet.findMany).toHaveBeenCalled();
  });

  it('départs espacés de 45 min : annulé — le double-run rapproché reste bloqué', async () => {
    const { svc, prisma } = build({ dernierDepart: ilYA(45) });
    await svc.runScheduled();
    expect(prisma.fleet.findMany).not.toHaveBeenCalled();
  });

  it("⚠️ la garde n'est PAS supprimée : instance NEUVE (redémarrage), départ persisté il y a 5 min → annulé", async () => {
    // `this.running` est frais dans ce build — comme après un conteneur recréé. Si ce test
    // casse un jour, c'est que la protection est retombée sur la seule mémoire de processus :
    // c'est l'interdiction n°3 de la fiche.
    const { svc, prisma } = build({ dernierDepart: ilYA(5) });
    await svc.runScheduled();
    expect(prisma.fleet.findMany).not.toHaveBeenCalled();
  });

  it("un tick annulé n'est PLUS silencieux — et n'écrit rien d'autre", async () => {
    // Dix ticks sur 24 disparaissaient chaque jour sans une ligne nulle part : le journal
    // système rend le compte possible. Et une annulation ne décale RIEN (ni settings ni run).
    const { svc, prisma, systemActivity } = build({ dernierDepart: ilYA(45) });
    await svc.runScheduled();
    expect(systemActivity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trip_automation_tick_annule', status: 'SKIPPED' }),
    );
    expect(prisma.tripAutomationSettings.update).not.toHaveBeenCalled();
    expect(prisma.tripAutomationRun.create).not.toHaveBeenCalled();
  });

  it('historique vide et lastRunAt nul : premier passage, le tick part', async () => {
    const { svc, prisma } = build({ dernierDepart: null });
    await svc.runScheduled();
    expect(prisma.fleet.findMany).toHaveBeenCalled();
  });

  it('historique illisible : repli sur lastRunAt (fin), sans crash — dégradé mais jamais moins prudent', async () => {
    // Le repli est l'ANCIEN point de mesure : trop prudent, jamais dangereux. La garde ne
    // disparaît dans aucun cas de panne.
    const { svc, prisma } = build({
      row: { lastRunAt: ilYA(10) },
      dernierDepart: 'illisible',
    });
    await expect(svc.runScheduled()).resolves.toBeUndefined();
    expect(prisma.fleet.findMany).not.toHaveBeenCalled();
  });

  describe('cadence quotidienne — marge 22 h, même point de mesure', () => {
    // Même helper d'heure Paris que la porte : le test doit ouvrir la porte « heure du jour ».
    const heureParisCourante = () =>
      parseInt(
        new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' })
          .formatToParts(new Date())
          .find((p) => p.type === 'hour')!.value,
        10,
      );

    it('24 h entre départs → part', async () => {
      const { svc, prisma } = build({
        row: { frequency: 'daily', hour: heureParisCourante() },
        dernierDepart: ilYA(24 * 60),
      });
      await svc.runScheduled();
      expect(prisma.fleet.findMany).toHaveBeenCalled();
    });

    it('16 h entre départs → annulé (marge 22 h)', async () => {
      const { svc, prisma } = build({
        row: { frequency: 'daily', hour: heureParisCourante() },
        dernierDepart: ilYA(16 * 60),
      });
      await svc.runScheduled();
      expect(prisma.fleet.findMany).not.toHaveBeenCalled();
    });
  });
});
