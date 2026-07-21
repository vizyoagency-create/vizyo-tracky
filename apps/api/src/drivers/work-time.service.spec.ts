import { aggregateTrips, parisDayOf, WorkTimeService } from './work-time.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { ErrorLogger } from '../observability/error-logger.service';

/**
 * RGPD 4.5 — registre du temps de travail : agrégation par (conducteur, jour Paris) avec conduite
 * pure + bornes d'amplitude, upserts idempotents, purge 5 ans tracée, CSV aux deux mesures.
 */
describe('aggregateTrips (pur)', () => {
  it('groupe par conducteur et jour Paris, cumule la conduite, garde min/max et les plaques', () => {
    const t = (h: number, dur: number, plate: string, driver = 'd1') => ({
      driverId: driver, fleetId: 'f1',
      startedAt: new Date(Date.UTC(2026, 6, 20, h, 0, 0)), // juillet → Paris = UTC+2
      endedAt: new Date(Date.UTC(2026, 6, 20, h, 30, 0)),
      durationSeconds: dur, vehiclePlate: plate,
    });
    const res = aggregateTrips([t(6, 1800, 'AA-111-AA'), t(9, 3600, 'BB-222-BB'), t(15, 600, 'AA-111-AA'), t(8, 900, 'CC-333-CC', 'd2')]);

    expect(res).toHaveLength(2);
    const d1 = res.find((r) => r.driverId === 'd1')!;
    expect(d1.day).toBe('2026-07-20');
    expect(d1.drivingSeconds).toBe(1800 + 3600 + 600);
    expect(d1.tripsCount).toBe(3);
    expect(d1.vehiclePlates.sort()).toEqual(['AA-111-AA', 'BB-222-BB']);
    expect(d1.firstTripStart.getUTCHours()).toBe(6);
    expect(d1.lastTripEnd.getUTCHours()).toBe(15);
  });

  it('un trajet après minuit Paris compte sur le bon jour civil', () => {
    // 23h30 UTC le 20 = 01h30 Paris le 21 (été).
    const res = aggregateTrips([{ driverId: 'd1', fleetId: 'f1', startedAt: new Date(Date.UTC(2026, 6, 20, 23, 30)), endedAt: null, durationSeconds: 60, vehiclePlate: null }]);
    expect(res[0].day).toBe('2026-07-21');
    expect(parisDayOf(new Date(Date.UTC(2026, 6, 20, 23, 30)))).toBe('2026-07-21');
  });

  it('ignore les trajets sans conducteur ou sans flotte', () => {
    expect(aggregateTrips([{ driverId: '', fleetId: 'f1', startedAt: new Date(), endedAt: null, durationSeconds: 1, vehiclePlate: null }])).toHaveLength(0);
  });
});

function makeService() {
  const prisma = {
    trip: { findMany: jest.fn().mockResolvedValue([]) },
    workTimeEntry: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const systemActivity = { record: jest.fn() };
  const errorLogger = { record: jest.fn().mockResolvedValue('id') };
  const service = new WorkTimeService(
    prisma as unknown as PrismaService,
    systemActivity as unknown as SystemActivityService,
    errorLogger as unknown as ErrorLogger,
  );
  return { service, prisma, systemActivity };
}

describe('WorkTimeService', () => {
  it('aggregateWindow : upsert idempotent par (driver, jour)', async () => {
    const { service, prisma } = makeService();
    prisma.trip.findMany.mockResolvedValue([
      { driverId: 'd1', fleetId: 'f1', startedAt: new Date(Date.UTC(2026, 6, 20, 6)), endedAt: new Date(Date.UTC(2026, 6, 20, 7)), durationSeconds: 3600, vehicle: { plate: 'AA-111-AA' } },
    ]);
    const res = await service.aggregateWindow(new Date(Date.UTC(2026, 6, 21, 4)));
    expect(res.entries).toBe(1);
    const call = prisma.workTimeEntry.upsert.mock.calls[0][0];
    expect(call.where.driverId_day.driverId).toBe('d1');
    expect(call.create.drivingSeconds).toBe(3600);
    expect(call.create.vehiclePlates).toEqual(['AA-111-AA']);
  });

  it('purgeExpired : > 5 ans supprimé + tracé RETENTION', async () => {
    const { service, prisma, systemActivity } = makeService();
    prisma.workTimeEntry.deleteMany.mockResolvedValue({ count: 12 });
    const n = await service.purgeExpired(new Date('2026-07-21T04:00:00Z'));
    expect(n).toBe(12);
    const cutoff = prisma.workTimeEntry.deleteMany.mock.calls[0][0].where.day.lt as Date;
    expect(cutoff.getUTCFullYear()).toBe(2021);
    expect(systemActivity.record.mock.calls[0][0]).toMatchObject({ category: 'RETENTION', action: 'work_time_purged' });
  });

  it('exportCsv : en-tête + amplitude ET conduite pure côte à côte', async () => {
    const { service, prisma } = makeService();
    prisma.workTimeEntry.findMany.mockResolvedValue([{
      day: new Date('2026-07-20T00:00:00Z'),
      firstTripStart: new Date('2026-07-20T06:00:00Z'), // 08:00 Paris
      lastTripEnd: new Date('2026-07-20T16:00:00Z'), // 18:00 Paris → amplitude 10 h
      drivingSeconds: 4 * 3600, // conduite 4 h
      tripsCount: 5,
      vehiclePlates: ['AA-111-AA'],
    }]);
    const csv = await service.exportCsv('d1', 'f1');
    const [header, row] = csv.split('\n');
    expect(header).toBe('jour;premiere_prise_de_service;derniere_fin;amplitude_h;conduite_h;trajets;vehicules');
    expect(row).toBe('2026-07-20;08:00;18:00;10,00;4,00;5;AA-111-AA');
  });
});
