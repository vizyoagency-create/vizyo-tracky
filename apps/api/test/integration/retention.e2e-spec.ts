import { PrismaClient } from '@prisma/client';
import { DataRetentionService } from '../../src/positions/data-retention.service';
import { LogCleanupService } from '../../src/observability/log-cleanup.service';
import { TripsRetentionService } from '../../src/trips/trips-retention.service';

/**
 * Lot 1 — PREUVE RÉELLE des purges, contre une VRAIE base Postgres.
 *
 * Ne s'exécute QUE si `TEST_DATABASE_URL` est défini (sinon la suite est ignorée : la CI et la
 * suite unitaire restent vertes sans base). Insère des lignes réellement datées, lance les
 * services de purge avec le vrai Prisma, puis vérifie ce qui a survécu.
 *
 *   TEST_DATABASE_URL="postgresql://user:pass@host:port/tracky_retention_test" \
 *     pnpm --filter @vizyo/tracky-api test:integration
 *
 * GARDE-FOU : refuse de tourner si le nom de base ne finit pas par `_test` — impossible de
 * viser une base de production par erreur.
 */
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;
const RUN = !!TEST_DB_URL;

const config = (values: Record<string, unknown>) => ({ get: (k: string) => values[k] }) as never;
const sysAct = { record: jest.fn() } as never;

(RUN ? describe : describe.skip)('Purges de données — intégration base réelle', () => {
  let prisma: PrismaClient;
  const created = { fleetId: '', vehicleId: '', trackerId: '' };

  beforeAll(async () => {
    const dbName = new URL(TEST_DB_URL as string).pathname.replace('/', '');
    if (!dbName.endsWith('_test')) {
      throw new Error(`REFUS : la base « ${dbName} » ne finit pas par _test (protection anti-production).`);
    }
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();

    const fleet = await prisma.fleet.create({ data: { name: 'Flotte test rétention' } });
    const vehicle = await prisma.vehicle.create({ data: { fleetId: fleet.id, plate: 'TEST-RET-01' } });
    const tracker = await prisma.tracker.create({ data: { imei: `TESTRET${Date.now()}`, vehicleId: vehicle.id } });
    created.fleetId = fleet.id;
    created.vehicleId = vehicle.id;
    created.trackerId = tracker.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    // Nettoyage complet (la cascade emporte positions/trips/trackers du véhicule).
    await prisma.smsLog.deleteMany({ where: { body: { startsWith: '[TEST-RET]' } } });
    await prisma.fleet.deleteMany({ where: { id: created.fleetId } });
    await prisma.$disconnect();
  });

  it('POSITIONS : celle de 61 jours est SUPPRIMÉE, celle de 59 jours est CONSERVÉE', async () => {
    const now = Date.now();
    const old = await prisma.position.create({
      data: { trackerId: created.trackerId, lat: 43.6, lng: 1.44, timestamp: new Date(now - 61 * DAY), createdAt: new Date(now - 61 * DAY) },
    });
    const recent = await prisma.position.create({
      data: { trackerId: created.trackerId, lat: 43.6, lng: 1.44, timestamp: new Date(now - 59 * DAY), createdAt: new Date(now - 59 * DAY) },
    });

    const svc = new DataRetentionService(
      prisma as never,
      config({ SAMPLING_DECISIONS_RETENTION_DAYS: 7, POSITIONS_RETENTION_DAYS: 60, POSITIONS_ARCHIVE_DAYS: 0, POSITIONS_PURGE_ENABLED: 'true', NODE_ENV: 'test' }),
      sysAct,
    );
    const res = await svc.runPositionsRetention();

    expect(res.mode).toBe('REAL');
    expect(await prisma.position.findUnique({ where: { id: old.id } })).toBeNull(); // purgée
    expect(await prisma.position.findUnique({ where: { id: recent.id } })).not.toBeNull(); // conservée
  });

  it('TRAJETS : celui de 13 mois est SUPPRIMÉ, celui de 11 mois est CONSERVÉ', async () => {
    const now = new Date();
    const at = (months: number): Date => {
      const d = new Date(now);
      d.setMonth(d.getMonth() - months);
      return d;
    };
    const old = await prisma.trip.create({ data: { vehicleId: created.vehicleId, fleetId: created.fleetId, startedAt: at(13) } });
    const recent = await prisma.trip.create({ data: { vehicleId: created.vehicleId, fleetId: created.fleetId, startedAt: at(11) } });

    const svc = new TripsRetentionService(
      prisma as never,
      config({ TRIPS_RETENTION_MONTHS: 12, TRIPS_PURGE_ENABLED: 'true', NODE_ENV: 'test' }),
      sysAct,
      { record: jest.fn().mockResolvedValue('id') } as never,
    );
    const res = await svc.runOnce();

    expect(res.mode).toBe('PURGE');
    expect(await prisma.trip.findUnique({ where: { id: old.id } })).toBeNull(); // purgé
    expect(await prisma.trip.findUnique({ where: { id: recent.id } })).not.toBeNull(); // conservé
  });

  it('SMS : celui de 91 jours est SUPPRIMÉ, celui de 89 jours est CONSERVÉ', async () => {
    const now = Date.now();
    const old = await prisma.smsLog.create({
      data: { direction: 'OUT', body: '[TEST-RET] vieux', toNumber: '+33600000001', createdAt: new Date(now - 91 * DAY) },
    });
    const recent = await prisma.smsLog.create({
      data: { direction: 'OUT', body: '[TEST-RET] recent', toNumber: '+33600000002', createdAt: new Date(now - 89 * DAY) },
    });

    const svc = new LogCleanupService(
      prisma as never,
      config({ WIRE_LOGS_RETENTION_DAYS: 7, ERROR_LOGS_RETENTION_DAYS: 30, MUTATION_AUDIT_RETENTION_DAYS: 365, SMS_LOGS_RETENTION_DAYS: 90 }),
      sysAct,
    );
    await svc.cleanupLogs();

    expect(await prisma.smsLog.findUnique({ where: { id: old.id } })).toBeNull(); // purgé
    expect(await prisma.smsLog.findUnique({ where: { id: recent.id } })).not.toBeNull(); // conservé
  });

  it('GARDE-FOU : une fenêtre de 6 jours ne supprime RIEN en base (le job échoue)', async () => {
    const now = Date.now();
    const p = await prisma.position.create({
      data: { trackerId: created.trackerId, lat: 43.6, lng: 1.44, timestamp: new Date(now - 400 * DAY), createdAt: new Date(now - 400 * DAY) },
    });

    const errorLogger = { recordBackground: jest.fn() };
    const svc = new DataRetentionService(
      prisma as never,
      config({ SAMPLING_DECISIONS_RETENTION_DAYS: 7, POSITIONS_RETENTION_DAYS: 6, POSITIONS_ARCHIVE_DAYS: 0, POSITIONS_PURGE_ENABLED: 'true', NODE_ENV: 'test' }),
      sysAct,
      errorLogger as never,
    );
    const res = await svc.runPositionsRetention();

    expect(res.disabled).toBe(true); // job échoué
    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(1);
    // La position de 400 jours est TOUJOURS là : le garde-fou a bien empêché la purge.
    expect(await prisma.position.findUnique({ where: { id: p.id } })).not.toBeNull();

    await prisma.position.delete({ where: { id: p.id } });
  });
});
