import { UnprocessableEntityException } from '@nestjs/common';
import { PositionsIntrouvablesException } from '../common/positions-introuvables.exception';
import { TripAnalysisService } from './trip-analysis.service';
import { TripAutomationService } from './trip-automation.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UN TRAJET SANS POSITIONS NE CRIE PLUS UNE FOIS PAR HEURE, POUR TOUJOURS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Mesuré en production le 2026-09-08. Le trajet du 08/07 de HD-597-XY, 3,2 km, zéro position
 * conservée — la plus vieille position en base datait du 10/07, donc les siennes étaient
 * purgées, définitivement — avait écrit **20 lignes d'erreur entre le 07/09 03:45 et le 08/09
 * 06:52**, une par passage horaire, et n'allait jamais s'arrêter.
 *
 * Deux causes qui se combinaient :
 *   1. `TripAnalysisService.analyze()` archivait TOUT échec de calcul au centre d'alerte,
 *      y compris ce refus délibéré. Les trois « on n'alerte pas » écrits en commentaire dans
 *      l'automatisation étaient donc annulés par la couche du dessous.
 *   2. Le gel du trajet n'existait que sur le chemin de la PREMIÈRE analyse. Les chemins
 *      « rejeu » et « reprise d'historique » le resélectionnaient à chaque passage.
 *
 * Ce qui est protégé ici :
 *   · le refus ne remonte pas au centre d'alerte, quel que soit l'appelant ;
 *   · les trois chemins figent le trajet, donc il sort du périmètre pour de bon ;
 *   · SOUS l'horizon de rétention le gel est muet (fait normal), AU-DESSUS il crie UNE fois
 *     (les positions devraient être là : c'est une anomalie, et le gel garantit l'unicité) ;
 *   · une autre erreur reste une vraie erreur : ni gel, ni silence.
 */
describe('Positions introuvables — refuser, figer, se taire', () => {
  const USER = { id: 'u-1', role: 'SUPER_ADMIN', fleetId: null } as never;

  // ── 1. La couche d'analyse ────────────────────────────────────────────────────────────

  function analyse(opts: { distanceMeters: number; positions?: unknown[] }) {
    const errorLogger = { record: jest.fn() };
    const prisma = {
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't-1', fleetId: 'f-1', vehicleId: 'v-1', trackerId: 'trk-1',
          startedAt: new Date('2026-07-08T15:10:00Z'), endedAt: new Date('2026-07-08T15:30:00Z'),
          distanceMeters: opts.distanceMeters,
          vehicle: { type: 'CAR', energy: 'DIESEL', fuelConsumptionL100km: 6.5 },
        }),
      },
      position: { findMany: jest.fn().mockResolvedValue(opts.positions ?? []) },
      tripAnalysis: { upsert: jest.fn().mockRejectedValue(new Error('jamais atteint')) },
    };
    const svc = new TripAnalysisService(
      prisma as never,
      { hasAccessToVehicle: jest.fn().mockResolvedValue(true) } as never,
      { buildResolver: jest.fn().mockResolvedValue(() => null) } as never,
      { attachStops: jest.fn(), enrich: jest.fn() } as never,
      errorLogger as never,
    );
    return { svc, errorLogger };
  }

  it("🔴 le refus « positions introuvables » n'atteint PAS le centre d'alerte", async () => {
    const { svc, errorLogger } = analyse({ distanceMeters: 3186, positions: [] });

    await expect(svc.analyze(USER, 't-1')).rejects.toThrow(PositionsIntrouvablesException);
    expect(errorLogger.record).not.toHaveBeenCalled();
  });

  it('une vraie panne de calcul, elle, est toujours archivée', async () => {
    const { svc, errorLogger } = analyse({ distanceMeters: 3186, positions: [{ lat: 1, lng: 1, speedKmh: 10, timestamp: new Date() }] });

    await expect(svc.analyze(USER, 't-1')).rejects.toThrow(/jamais atteint/);
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.any(Error),
      'trip-analysis',
      expect.objectContaining({ tripId: 't-1', stage: 'compute' }),
    );
  });

  // ── 2. L'automatisation : les trois chemins ───────────────────────────────────────────

  const JOUR = 86_400_000;
  const REFUS = () => new PositionsIntrouvablesException('Analyse impossible : les positions de ce trajet ne sont plus disponibles.');

  /**
   * Un harnais qui ne laisse passer QU'UN trajet, et par un seul chemin à la fois : c'est le
   * chemin qui est testé, pas le pipeline. `analyze` rejette toujours avec le refus.
   */
  function automatisation(opts: {
    chemin: 'premiere-analyse' | 'rejeu' | 'reprise';
    ageJours: number;
    rejet?: Error;
  }) {
    const startedAt = new Date(Date.now() - opts.ageJours * JOUR);
    const trip = { id: 't-mort', startedAt, endedAt: new Date(startedAt.getTime() + 20 * 60_000), distanceMeters: 3186 };
    const prisma = {
      tripAutomationSettings: {
        findFirst: jest.fn().mockResolvedValue({
          id: 's1', enabled: true, frequency: 'hourly', hour: 2, lookbackHours: 26,
          recomputeTrips: false, narrateEnabled: false, maxAnalysesPerRun: 300,
          maxNarrationsPerRun: 60, lastRunAt: null, lastRunStats: null,
          updatedByUserId: null, createdAt: new Date(), updatedAt: new Date(),
        }),
        create: jest.fn(), update: jest.fn().mockResolvedValue({}),
      },
      tripAutomationRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      fleet: { findMany: jest.fn().mockResolvedValue(opts.chemin === 'premiere-analyse' ? [{ id: 'f1', name: 'Flotte' }] : []) },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'HD-597-XY', tracker: { id: 'trk-1', lastSeenAt: new Date() } },
        ]),
      },
      position: { count: jest.fn().mockResolvedValue(5) },
      trip: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([trip]),
        findUnique: jest.fn().mockResolvedValue({ startedAt }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      tripAnalysis: {
        findMany: jest.fn().mockResolvedValue(
          opts.chemin === 'rejeu' ? [{ tripId: 't-mort', vehicleId: 'v1', fleetId: 'f1', limitsCoverage: 0.1 }] : [],
        ),
      },
      $queryRaw: jest.fn().mockResolvedValue(opts.chemin === 'reprise' ? [{ tripId: 't-mort' }] : []),
    };
    const analysis = { analyze: jest.fn().mockRejectedValue(opts.rejet ?? REFUS()) };
    const errorLogger = { record: jest.fn().mockResolvedValue('id') };
    const svc = new TripAutomationService(
      prisma as never,
      { recompute: jest.fn().mockResolvedValue({ deleted: 0, created: 0 }) } as never,
      analysis as never,
      { narrate: jest.fn() } as never,
      { isEnabledForFleet: jest.fn().mockResolvedValue(false) } as never,
      errorLogger as never,
      { record: jest.fn() } as never,
      // Rattrapage du recalage (2026-09-08) : jamais atteint ici, les trajets simules n'ont pas de trace stocke.
      { recaler: jest.fn().mockResolvedValue({ polylineMatched: null, enCours: false }) } as never,
    );
    return { svc, prisma, analysis, errorLogger };
  }

  /** Le marqueur écrit sur le trajet, ou null si rien n'a été figé. */
  const marqueur = (prisma: { trip: { update: jest.Mock } }): string | null =>
    prisma.trip.update.mock.calls
      .map((c) => (c[0] as { data?: { segmentationSource?: string } }).data?.segmentationSource)
      .find((s): s is string => typeof s === 'string') ?? null;

  for (const chemin of ['premiere-analyse', 'rejeu', 'reprise'] as const) {
    it(`🔴 chemin « ${chemin} » : sous l'horizon, le trajet est FIGÉ et personne n'est alerté`, async () => {
      const { svc, prisma, analysis, errorLogger } = automatisation({ chemin, ageJours: 62 });

      await svc.runNow();

      expect(analysis.analyze).toHaveBeenCalledWith(expect.anything(), 't-mort');
      expect(marqueur(prisma)).toBe('fige-retention');
      expect(errorLogger.record).not.toHaveBeenCalled();
    });
  }

  it("🔴 AU-DESSUS de l'horizon : figé sous un marqueur distinct, et l'anomalie est dite UNE fois", async () => {
    // Les positions devraient être là. C'est une vraie anomalie : elle doit crier — mais une
    // seule fois, et c'est le gel qui le garantit.
    const { svc, prisma, errorLogger } = automatisation({ chemin: 'rejeu', ageJours: 3 });

    await svc.runNow();

    expect(marqueur(prisma)).toBe('fige-sans-positions');
    expect(errorLogger.record).toHaveBeenCalledTimes(1);
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.any(Error),
      'TRIP_AUTOMATION',
      expect.objectContaining({ tripId: 't-mort', marqueur: 'fige-sans-positions' }),
      'ERROR',
    );
  });

  it("une autre erreur n'est pas un gel : le trajet reste au périmètre et l'échec est archivé", async () => {
    const { svc, prisma, errorLogger } = automatisation({
      chemin: 'premiere-analyse',
      ageJours: 62,
      rejet: new Error('Overpass injoignable'),
    });

    await svc.runNow();

    expect(marqueur(prisma)).toBeNull();
    expect(errorLogger.record).toHaveBeenCalledWith(
      expect.any(Error),
      'TRIP_AUTOMATION',
      expect.objectContaining({ tripId: 't-mort', phase: 'analyze' }),
    );
  });

  it("un refus 422 ORDINAIRE n'est pas confondu avec l'absence de positions", async () => {
    // Le gel est un geste définitif : il ne doit s'appliquer qu'au cas qu'il décrit.
    const { svc, prisma } = automatisation({
      chemin: 'premiere-analyse',
      ageJours: 62,
      rejet: new UnprocessableEntityException('autre chose'),
    });

    await svc.runNow();

    expect(marqueur(prisma)).toBeNull();
  });
});
