import { TripsRetentionService } from './trips-retention.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { ErrorLogger } from '../observability/error-logger.service';

/**
 * RGPD 4.1 — rétention des trajets : DRY-RUN par défaut (compte + trace, 0 effacé),
 * purge armée = suppression par lots AVEC les tables liées sans FK (TripAnalysis,
 * TripFuelStop), désactivable (months=0).
 */
function makeService(env: Record<string, unknown>) {
  const prisma = {
    trip: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    tripAnalysis: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    tripFuelStop: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const config = { get: jest.fn((k: string) => env[k]) };
  const systemActivity = { record: jest.fn() };
  const errorLogger = { record: jest.fn().mockResolvedValue('id') };
  const service = new TripsRetentionService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService<never, true>,
    systemActivity as unknown as SystemActivityService,
    errorLogger as unknown as ErrorLogger,
  );
  return { service, prisma, systemActivity };
}

describe('TripsRetentionService', () => {
  it('months=0 → désactivé, aucune requête', async () => {
    const { service, prisma } = makeService({ TRIPS_RETENTION_MONTHS: 0, TRIPS_PURGE_ENABLED: 'true' });
    const res = await service.runOnce();
    expect(res.mode).toBe('DISABLED');
    expect(prisma.trip.count).not.toHaveBeenCalled();
  });

  it('DRY-RUN (défaut) : compte + trace RETENTION/SKIPPED, RIEN d\'effacé', async () => {
    const { service, prisma, systemActivity } = makeService({ TRIPS_RETENTION_MONTHS: 12, TRIPS_PURGE_ENABLED: 'false' });
    prisma.trip.count.mockResolvedValue(321);

    const res = await service.runOnce(new Date('2026-07-21T03:45:00Z'));

    expect(res).toMatchObject({ mode: 'DRY_RUN', candidates: 321, deleted: 0 });
    expect(prisma.trip.deleteMany).not.toHaveBeenCalled();
    expect(prisma.tripAnalysis.deleteMany).not.toHaveBeenCalled();
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ category: 'RETENTION', action: 'trips_retention', status: 'SKIPPED' });
    // Seuil correct : 12 mois avant le run.
    const where = prisma.trip.count.mock.calls[0][0].where.startedAt.lt as Date;
    expect(where.toISOString().startsWith('2025-07-21')).toBe(true);
  });

  it('purge ARMÉE : lots supprimés AVEC TripAnalysis + TripFuelStop, trace SUCCESS', async () => {
    const { service, prisma, systemActivity } = makeService({ TRIPS_RETENTION_MONTHS: 12, TRIPS_PURGE_ENABLED: 'true' });
    prisma.trip.count.mockResolvedValue(3);
    prisma.trip.findMany
      .mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }, { id: 't3' }])
      .mockResolvedValueOnce([]); // 2e lot vide → stop
    prisma.trip.deleteMany.mockResolvedValue({ count: 3 });

    const res = await service.runOnce();

    expect(res).toMatchObject({ mode: 'PURGE', candidates: 3, deleted: 3 });
    expect(prisma.tripFuelStop.deleteMany).toHaveBeenCalledWith({ where: { tripId: { in: ['t1', 't2', 't3'] } } });
    expect(prisma.tripAnalysis.deleteMany).toHaveBeenCalledWith({ where: { tripId: { in: ['t1', 't2', 't3'] } } });
    expect(prisma.trip.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['t1', 't2', 't3'] } } });
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ category: 'RETENTION', action: 'trips_purged', status: 'SUCCESS' });
  });

  it('DRY-RUN sans candidat : pas de bruit au journal', async () => {
    const { service, prisma, systemActivity } = makeService({ TRIPS_RETENTION_MONTHS: 12, TRIPS_PURGE_ENABLED: 'false' });
    prisma.trip.count.mockResolvedValue(0);
    await service.runOnce();
    expect(systemActivity.record).not.toHaveBeenCalled();
  });
});

describe('TripsRetentionService — purge REELLE 12 mois (lot 1)', () => {
  it('un trajet de 13 mois est PURGE, un trajet de 11 mois est CONSERVE', async () => {
    const { service, prisma } = makeService({ TRIPS_RETENTION_MONTHS: 12, TRIPS_PURGE_ENABLED: 'true' });
    prisma.trip.count.mockResolvedValue(1);
    prisma.trip.findMany.mockResolvedValueOnce([{ id: 't-vieux' }]).mockResolvedValueOnce([]);
    prisma.trip.deleteMany.mockResolvedValue({ count: 1 });

    const now = new Date('2026-07-21T03:45:00Z');
    await service.runOnce(now);

    // Borne reellement utilisee par le comptage et la selection des lots.
    const cutoff = prisma.trip.count.mock.calls[0][0].where.startedAt.lt as Date;
    const trip13mois = new Date('2025-06-21T12:00:00Z'); // 13 mois avant `now`
    const trip11mois = new Date('2025-08-21T12:00:00Z'); // 11 mois avant `now`
    expect(trip13mois.getTime()).toBeLessThan(cutoff.getTime()); // supprime
    expect(trip11mois.getTime()).toBeGreaterThan(cutoff.getTime()); // conserve
    expect(cutoff.toISOString().slice(0, 10)).toBe('2025-07-21'); // exactement 12 mois
    expect(prisma.trip.deleteMany).toHaveBeenCalled();
  });

  it('GARDE-FOU : une fenetre de 0,5 mois (~15 j) fait ECHOUER le job, rien n est supprime', async () => {
    const { service, prisma } = makeService({ TRIPS_RETENTION_MONTHS: 0.5, TRIPS_PURGE_ENABLED: 'true' });
    await expect(service.runOnce()).rejects.toThrow(/30 j/);
    expect(prisma.trip.deleteMany).not.toHaveBeenCalled();
    expect(prisma.trip.count).not.toHaveBeenCalled();
  });

  it('le cron rattrape l echec du garde-fou et le remonte au centre d alerte', async () => {
    const prismaLocal = {
      trip: { count: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() },
      tripAnalysis: { deleteMany: jest.fn() },
      tripFuelStop: { deleteMany: jest.fn() },
    };
    const errors = { record: jest.fn().mockResolvedValue('id') };
    const svc = new TripsRetentionService(
      prismaLocal as never,
      { get: (k: string) => ({ TRIPS_RETENTION_MONTHS: 0.5, TRIPS_PURGE_ENABLED: 'true' } as Record<string, unknown>)[k] } as never,
      { record: jest.fn() } as never,
      errors as never,
    );

    await expect(svc.run()).resolves.toBeUndefined(); // le cron ne jette jamais
    expect(errors.record).toHaveBeenCalledTimes(1);
    expect(errors.record.mock.calls[0][1]).toBe('trips-retention');
  });

  it('PRODUCTION : TRIPS_PURGE_ENABLED=false est IGNORE (purge quand meme armee)', async () => {
    const { service, prisma } = makeService({ NODE_ENV: 'production', TRIPS_RETENTION_MONTHS: 12, TRIPS_PURGE_ENABLED: 'false' });
    prisma.trip.count.mockResolvedValue(2);
    prisma.trip.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]).mockResolvedValueOnce([]);
    prisma.trip.deleteMany.mockResolvedValue({ count: 2 });

    const res = await service.runOnce();

    expect(res.mode).toBe('PURGE');
    expect(res.deleted).toBe(2);
  });
});
