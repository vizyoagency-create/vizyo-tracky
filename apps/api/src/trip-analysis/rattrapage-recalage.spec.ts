import { TripAutomationService } from './trip-automation.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * RATTRAPER LES TRACÉS QUI NE SUIVENT PAS LA ROUTE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le recalage sur les routes se fait à la clôture du trajet. Il a échoué pendant des mois pour
 * tout trajet de plus de dix points, faute de connaître la limite réelle du service public
 * OSRM. Mesuré en production le 2026-09-08, juste après le correctif :
 *
 *   · 31 trajets sur 31 clôturés DEPUIS portent un tracé recalé ;
 *   · 156 sur 1 217 clôturés AVANT ;
 *   · 4 641 trajets des trente derniers jours restent sans tracé recalé.
 *
 * Le correctif soigne donc les trajets neufs et laisse l'historique couper les virages. Ce
 * rattrapage-ci le reprend par lots bornés, à la fin de chaque passage.
 *
 * Ce qui est protégé ici :
 *   · on ne prend QUE des trajets sans tracé recalé, et jamais plus que l'enveloppe ;
 *   · un refus d'OSRM n'est pas retenté à l'infini — sans cette mémoire, les mêmes tracés
 *     occuperaient les quinze places à chaque passage et le rattrapage tournerait en rond ;
 *   · le budget de temps du passage arrête la boucle, comme partout ailleurs ;
 *   · le rattrapage passe APRÈS les analyses : un tracé plus joli ne vaut pas une analyse ;
 *   · il se coupe sans déploiement, et une panne de sélection ne casse pas le passage.
 */
describe('Rattrapage du recalage des tracés', () => {
  const ancienne = process.env.RECALAGE_RATTRAPAGE_PAR_PASSAGE;
  afterEach(() => {
    if (ancienne === undefined) delete process.env.RECALAGE_RATTRAPAGE_PAR_PASSAGE;
    else process.env.RECALAGE_RATTRAPAGE_PAR_PASSAGE = ancienne;
  });

  /** N trajets de l'historique, tous avec un tracé brut et aucun tracé recalé. */
  const aRecaler = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `t-${i}`, polyline: '[{"lat":43.6,"lng":1.44},{"lat":43.61,"lng":1.45}]' }));

  function build(opts: {
    candidats?: { id: string; polyline: string | null }[];
    recale?: jest.Mock;
    selectionEnPanne?: boolean;
  } = {}) {
    const ordre: string[] = [];
    const row = {
      id: 's1', enabled: true, frequency: 'hourly', hour: 2, lookbackHours: 26,
      recomputeTrips: false, narrateEnabled: false, maxAnalysesPerRun: 300,
      maxNarrationsPerRun: 60, lastRunAt: null, lastRunStats: null,
      updatedByUserId: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const prisma = {
      tripAutomationSettings: {
        findFirst: jest.fn().mockResolvedValue(row),
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
      tripAutomationRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // Aucune flotte : la boucle des véhicules ne tourne pas, c'est le rattrapage qu'on regarde.
      fleet: { findMany: jest.fn().mockResolvedValue([]) },
      vehicle: { findMany: jest.fn().mockResolvedValue([]) },
      position: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
      trip: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        // Seule la sélection du rattrapage porte `polylineMatched: null` : le simulacre répond
        // à CELLE-LÀ, et rend une liste vide aux autres lectures de trajets.
        findMany: jest.fn(async (args?: { where?: Record<string, unknown> }) => {
          if (!args?.where || !('polylineMatched' in args.where)) return [];
          ordre.push('rattrapage');
          if (opts.selectionEnPanne) throw new Error('base illisible');
          const take = (args as { take?: number }).take ?? 15;
          const exclus = new Set(((args.where.id as { notIn?: string[] })?.notIn ?? []) as string[]);
          return (opts.candidats ?? aRecaler(3)).filter((c) => !exclus.has(c.id)).slice(0, take);
        }),
      },
      tripAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(async () => { ordre.push('reprise'); return []; }),
    };
    const recale = opts.recale ?? jest.fn().mockResolvedValue({ polylineMatched: '[{"lat":1,"lng":1}]', enCours: false });
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const svc = new TripAutomationService(
      prisma as never,
      { recompute: jest.fn() } as never,
      { analyze: jest.fn() } as never,
      { narrate: jest.fn() } as never,
      { isEnabledForFleet: jest.fn().mockResolvedValue(false) } as never,
      errorLogger as never,
      { record: jest.fn() } as never,
      { recaler: recale } as never,
    );
    return { svc, prisma, recale, errorLogger, ordre };
  }

  it('🔴 ne prend que les trajets SANS tracé recalé, les plus récents d’abord, et pas plus que l’enveloppe', async () => {
    const { svc, prisma } = build();

    await svc.runNow();

    expect(prisma.trip.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ polylineMatched: null, polyline: { not: null }, endedAt: { not: null } }),
        orderBy: { startedAt: 'desc' },
        take: 15,
      }),
    );
  });

  it('🔴 recale chaque candidat et compte ce qui a été fait', async () => {
    const { svc, recale } = build({ candidats: aRecaler(3) });

    const stats = await svc.runNow();

    expect(recale).toHaveBeenCalledTimes(3);
    expect(recale).toHaveBeenCalledWith('t-0', expect.objectContaining({ accessibleVehicleIds: 'ALL' }));
    expect(stats.recalesTraces).toBe(3);
  });

  it('🔴 un tracé qu’OSRM refuse n’est pas repris au passage suivant', async () => {
    // Sans cette mémoire, les mêmes tracés impossibles occuperaient toutes les places à chaque
    // passage : le rattrapage tournerait en rond, exactement comme les analyses avant leur gel.
    const { svc, prisma, recale } = build({
      candidats: aRecaler(2),
      recale: jest.fn().mockResolvedValue({ polylineMatched: null, enCours: false }),
    });

    await svc.runNow();
    expect(recale).toHaveBeenCalledTimes(2);

    await svc.runNow();

    expect(recale).toHaveBeenCalledTimes(2); // aucun nouvel essai
    const derniere = prisma.trip.findMany.mock.calls.at(-1)![0] as { where: { id?: { notIn: string[] } } };
    expect(derniere.where.id?.notIn).toEqual(expect.arrayContaining(['t-0', 't-1']));
  });

  it('🔴 une panne d’OSRM ne casse pas le passage, et n’alerte pas', async () => {
    // Service public, gratuit : il tombe. Le tracé brut reste affiché, rien n'est en panne ici.
    const { svc, errorLogger } = build({
      candidats: aRecaler(2),
      recale: jest.fn().mockRejectedValue(new Error('OSRM 429')),
    });

    const stats = await svc.runNow();

    expect(stats.recalesTraces).toBe(0);
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('🔴 le rattrapage passe APRÈS la reprise des analyses', async () => {
    const { svc, ordre } = build();

    await svc.runNow();

    expect(ordre.indexOf('reprise')).toBeLessThan(ordre.indexOf('rattrapage'));
  });

  it('se coupe sans déploiement (enveloppe à zéro)', async () => {
    process.env.RECALAGE_RATTRAPAGE_PAR_PASSAGE = '0';
    const { svc, recale, ordre } = build();

    await svc.runNow();

    expect(recale).not.toHaveBeenCalled();
    expect(ordre).not.toContain('rattrapage');
  });

  it('une enveloppe absurde retombe sur le défaut, et le plafond ne se franchit pas', async () => {
    process.env.RECALAGE_RATTRAPAGE_PAR_PASSAGE = 'beaucoup';
    const a = build();
    await a.svc.runNow();
    expect((a.prisma.trip.findMany.mock.calls.at(-1)![0] as { take: number }).take).toBe(15);

    process.env.RECALAGE_RATTRAPAGE_PAR_PASSAGE = '5000';
    const b = build();
    await b.svc.runNow();
    expect((b.prisma.trip.findMany.mock.calls.at(-1)![0] as { take: number }).take).toBe(50);
  });

  it('une sélection en panne est archivée et ne casse pas le passage', async () => {
    const { svc, errorLogger } = build({ selectionEnPanne: true });

    const stats = await svc.runNow();

    expect(stats.recalesTraces).toBe(0);
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.any(Error), 'TRIP_AUTOMATION',
      expect.objectContaining({ phase: 'rattrapage-recalage' }),
    );
  });
});
