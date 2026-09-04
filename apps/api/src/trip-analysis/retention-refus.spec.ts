import { UnprocessableEntityException } from '@nestjs/common';
import { TripAutomationService } from './trip-automation.service';

/**
 * ── CE QUE CES TESTS EMPÊCHENT : LA BOUCLE DE BRUIT SUR UN FAIT SANS REMÈDE ──────────
 *
 * La fenêtre de rattrapage (1 500 h ≈ 62 jours) DÉBORDE l'horizon de rétention (60 jours) :
 * elle vise une zone où les positions n'existent plus par construction. Le 2026-08-21, cela
 * produisait 26 alertes en dix heures pour 82 trajets du 20 au 22 juin — tous `recompute`
 * (stabilisés en juillet quand leurs positions vivaient encore), donc jamais « sales », donc
 * jamais gelés par le front de recalcul. Ni analysables, ni écartés : re-sélectionnés à chaque
 * passage, indéfiniment.
 *
 * Deux demi-gestes complémentaires, testés ici :
 *   — PRÉVENTION : le complément « anciens sans analyse » ne descend plus sous l'horizon ;
 *   — GUÉRISON  : un refus sous l'horizon GÈLE le trajet, sans alerter.
 *
 * Et la distinction qui compte : le MÊME refus au-dessus de l'horizon est une vraie anomalie
 * (les positions devraient être là). Geler les deux cas sans distinction étoufferait la panne
 * avec le fait normal.
 */
const JOUR = 86_400_000;

function build(opts: {
  trips?: { id: string; startedAt: Date }[];
  anciens?: { id: string; startedAt: Date }[];
  analyzeRejette?: unknown;
  positions?: number;
  dirty?: { startedAt: Date } | null;
  lookbackHours?: number;
}) {
  const row = {
    id: 's1', enabled: true, frequency: 'hourly', hour: 2,
    lookbackHours: opts.lookbackHours ?? 1500, recomputeTrips: true, narrateEnabled: false,
    maxAnalysesPerRun: 300, maxNarrationsPerRun: 60,
    lastRunAt: null, lastRunStats: null, updatedByUserId: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const findMany = jest
    .fn()
    .mockResolvedValueOnce(opts.trips ?? [])
    .mockResolvedValueOnce(opts.anciens ?? []);
  const prisma = {
  /**
   * La reprise de l'historique lit ses candidats en SQL brut (`NOT (detail ? 'vitesse')` n'a pas
   * d'équivalent dans l'API typée de Prisma). Un simulacre qui l'omet décrit un client Prisma
   * qui n'existe pas, et fait passer la reprise pour une panne.
   */
    $queryRaw: jest.fn().mockResolvedValue([]),
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
    fleet: { findMany: jest.fn().mockResolvedValue([{ id: 'f1', name: 'Flotte A' }]) },
    vehicle: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'v1', plate: 'AA-001-BB', tracker: { id: 'tk1', lastSeenAt: new Date() } },
      ]),
    },
    position: { count: jest.fn().mockResolvedValue(opts.positions ?? 42) },
    trip: {
      findFirst: jest.fn().mockResolvedValue(opts.dirty ?? null),
      findMany,
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    tripAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const analysis = {
    analyze: opts.analyzeRejette
      ? jest.fn().mockRejectedValue(opts.analyzeRejette)
      : jest.fn().mockResolvedValue({}),
  };
  const errorLogger = { record: jest.fn().mockResolvedValue('id') };
  const svc = new TripAutomationService(
    prisma as never,
    { recompute: jest.fn().mockResolvedValue({ deleted: 0, created: 2 }) } as never,
    analysis as never,
    { narrate: jest.fn() } as never,
    { isEnabledForFleet: jest.fn().mockResolvedValue(true) } as never,
    errorLogger as never,
    { record: jest.fn() } as never,
  );
  return { svc, prisma, analysis, errorLogger, findMany };
}

const REFUS = () =>
  new UnprocessableEntityException(
    'Analyse impossible : les positions de ce trajet ne sont plus disponibles.',
  );

describe('Refus pour positions purgées — guérir sans crier', () => {
  it('⚠️ SOUS l’horizon : le trajet est GELÉ et AUCUNE alerte n’est levée', async () => {
    // 62 jours : au-delà de la rétention de 60 jours, l'absence est un fait définitif.
    const { svc, prisma, errorLogger } = build({
      trips: [{ id: 't-vieux', startedAt: new Date(Date.now() - 62 * JOUR) }],
      analyzeRejette: REFUS(),
    });

    await svc.runNow();

    expect(prisma.trip.update).toHaveBeenCalledWith({
      where: { id: 't-vieux' },
      data: { segmentationSource: 'fige-retention' },
    });
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('⚠️ AU-DESSUS de l’horizon : le même refus ALERTE et ne gèle rien — c’est une panne', async () => {
    // 10 jours : les positions devraient être là. Geler ici étoufferait une vraie anomalie
    // (purge trop agressive, ingestion cassée) sous le fait normal.
    const { svc, prisma, errorLogger } = build({
      trips: [{ id: 't-recent', startedAt: new Date(Date.now() - 10 * JOUR) }],
      analyzeRejette: REFUS(),
    });

    await svc.runNow();

    expect(prisma.trip.update).not.toHaveBeenCalled();
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.any(Error), expect.anything(),
      expect.objectContaining({ tripId: 't-recent', phase: 'analyze' }),
    );
  });

  it('un trajet gelé est compté comme sauté, pas comme un échec', async () => {
    // `failed` doit rester le compteur des vraies pannes : le gonfler avec des refus attendus
    // rendrait illisible la santé du passage (93 « échecs » relevés le 2026-08-21).
    const { svc } = build({
      trips: [{ id: 't-vieux', startedAt: new Date(Date.now() - 62 * JOUR) }],
      analyzeRejette: REFUS(),
    });

    const stats = await svc.runNow();

    expect(stats.failed).toBe(0);
    expect(stats.skippedNoPositions).toBeGreaterThanOrEqual(1);
  });

  it('une erreur ORDINAIRE reste un échec alerté — le gel ne doit rien avaler d’autre', async () => {
    const { svc, prisma, errorLogger } = build({
      trips: [{ id: 't1', startedAt: new Date(Date.now() - 62 * JOUR) }],
      analyzeRejette: new Error('base injoignable'),
    });

    const stats = await svc.runNow();

    expect(stats.failed).toBe(1);
    expect(prisma.trip.update).not.toHaveBeenCalled();
    expect(errorLogger.record).toHaveBeenCalled();
  });
});

describe('Complément des anciens sans analyse — le plancher de rétention', () => {
  it('⚠️ ne sélectionne JAMAIS sous l’horizon : on ne ramène pas ce qui ne peut plus être analysé', async () => {
    const { svc, findMany } = build({ trips: [], anciens: [] });

    await svc.runNow();

    // Deuxième appel = le complément. Sa borne basse doit être l'horizon (≈ 59 j), et non
    // la fenêtre de 1 500 h (≈ 62 j) qui déborde dans la zone purgée.
    const complement = findMany.mock.calls[1]?.[0];
    expect(complement).toBeDefined();
    const borne = complement.where.startedAt.gte as Date;
    const ageJours = (Date.now() - borne.getTime()) / JOUR;
    expect(ageJours).toBeLessThan(61);
    expect(complement.where.segmentationSource).toEqual({ notIn: ['fige-retention', 'fige-sans-positions'] });
  });
});

describe('Tranche vide — le plancher de fenêtre', () => {
  /**
   * La tranche à recalculer est bornée en haut par `windowTo` (maintenant moins dix minutes).
   * Quand le front de recalcul rattrape le présent, la DERNIÈRE tranche est rognée et peut
   * devenir arbitrairement courte — c'est ainsi qu'est née la fenêtre de 2,041 s relevée sur
   * FV-941-LZ le 2026-08-21. On reproduit exactement cela en resserrant la fenêtre de travail.
   */
  const alertesNoPositions = (errorLogger: { record: jest.Mock }) =>
    errorLogger.record.mock.calls.filter((c) =>
      String((c[2] as { phase?: string })?.phase ?? '').includes('no-positions'),
    );

  it('⚠️ une tranche plus courte que la cadence d’émission n’alerte pas (faux positif par construction)', async () => {
    // Les boîtiers émettent toutes les ~20 s : une fenêtre de deux secondes ne peut PAS contenir
    // de position, même quand tout va bien. Affirmer une anomalie ici serait mécaniquement faux.
    const { svc, errorLogger } = build({
      lookbackHours: 602 / 3600, // borne basse 2 s sous la borne haute
      dirty: { startedAt: new Date(Date.now() - 30 * JOUR) },
      positions: 0,
      trips: [],
    });

    await svc.runNow();

    expect(alertesNoPositions(errorLogger)).toHaveLength(0);
  });

  it('… mais une tranche NORMALE sans position alerte toujours — le plancher ne doit rien étouffer', async () => {
    // Le contre-exemple qui prouve que le test ci-dessus ne passe pas pour une mauvaise raison.
    const { svc, errorLogger } = build({
      lookbackHours: 6, // tranche de plusieurs heures : l'absence y est une vraie information
      dirty: { startedAt: new Date(Date.now() - 30 * JOUR) },
      positions: 0,
      trips: [],
    });

    await svc.runNow();

    expect(alertesNoPositions(errorLogger)).toHaveLength(1);
  });

  it('⚠️ … et le front AVANCE quand même : alerter sans débloquer condamnait tout ce qui suit', async () => {
    /**
     * Le défaut le plus coûteux de la série, parce qu'il était silencieux dans ses effets :
     * l'alerte partait, mais rien n'avançait. `dirty` retombait sur la même tranche à chaque
     * passage — alerte répétée, et TOUS les trajets postérieurs jamais recalculés. Mesuré sur
     * FZ-862-VY, tranche du 24 au 26 juin : 57 trajets bloqués derrière elle.
     *
     * Marqueur DISTINCT de la rétention : ici les positions devraient être là. Le trajet est
     * figé pareil (le travail est impossible dans les deux cas), mais reste repérable.
     */
    const { svc, prisma } = build({
      lookbackHours: 6,
      dirty: { startedAt: new Date(Date.now() - 30 * JOUR) },
      positions: 0,
      trips: [],
    });

    await svc.runNow();

    expect(prisma.trip.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { segmentationSource: 'fige-sans-positions' } }),
    );
  });
});
