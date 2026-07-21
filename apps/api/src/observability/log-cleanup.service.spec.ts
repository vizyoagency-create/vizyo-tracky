import { LogCleanupService } from './log-cleanup.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { ErrorLogger } from './error-logger.service';

/**
 * Lot 1 — purge RÉELLE des journaux SMS (`sms_logs` : numéros + contenu = données personnelles)
 * à 90 jours, avec le garde-fou commun < 30 j.
 */
const DAY = 86_400_000;

function makeService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    WIRE_LOGS_RETENTION_DAYS: 7,
    ERROR_LOGS_RETENTION_DAYS: 30,
    MUTATION_AUDIT_RETENTION_DAYS: 365,
    SMS_LOGS_RETENTION_DAYS: 90,
    ...overrides,
  };
  const prisma = {
    wireLog: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    errorLog: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    systemActivityLog: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    smsLog: { deleteMany: jest.fn().mockResolvedValue({ count: 4 }) },
  };
  const systemActivity = { record: jest.fn() };
  const errorLogger = { recordBackground: jest.fn() };
  const service = new LogCleanupService(
    prisma as unknown as PrismaService,
    { get: (k: string) => values[k] } as unknown as ConfigService<never, true>,
    systemActivity as unknown as SystemActivityService,
    errorLogger as unknown as ErrorLogger,
  );
  return { service, prisma, systemActivity, errorLogger };
}

describe('LogCleanupService — rétention des journaux SMS', () => {
  it('un SMS de 91 j est PURGÉ, un SMS de 89 j est CONSERVÉ (borne 90 j)', async () => {
    const { service, prisma } = makeService();
    await service.cleanupLogs();

    const cutoff = prisma.smsLog.deleteMany.mock.calls[0][0].where.createdAt.lt as Date;
    const now = Date.now();
    expect(new Date(now - 91 * DAY).getTime()).toBeLessThan(cutoff.getTime()); // purgé
    expect(new Date(now - 89 * DAY).getTime()).toBeGreaterThan(cutoff.getTime()); // conservé
    expect(Math.abs(cutoff.getTime() - (now - 90 * DAY))).toBeLessThan(60_000);
  });

  it('la purge SMS est tracée au journal système (catégorie RETENTION)', async () => {
    const { service, systemActivity } = makeService();
    await service.cleanupLogs();
    const entry = systemActivity.record.mock.calls[0][0];
    expect(entry).toMatchObject({ category: 'RETENTION', action: 'logs_purged' });
    expect(entry.meta).toMatchObject({ smsDeleted: 4, smsDays: 90 });
  });

  it('GARDE-FOU : SMS_LOGS_RETENTION_DAYS=10 fait ÉCHOUER le job, aucun journal supprimé', async () => {
    const { service, prisma } = makeService({ SMS_LOGS_RETENTION_DAYS: 10 });
    await expect(service.cleanupLogs()).rejects.toThrow(/30 j/);
    expect(prisma.smsLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.wireLog.deleteMany).not.toHaveBeenCalled(); // le garde-fou passe AVANT toute suppression
  });

  it('le cron rattrape l’échec et le remonte au centre d’alerte (pas de rejet non capté)', async () => {
    const { service, errorLogger } = makeService({ SMS_LOGS_RETENTION_DAYS: 10 });
    await expect(service.runCleanup()).resolves.toBeUndefined();
    expect(errorLogger.recordBackground).toHaveBeenCalledTimes(1);
    expect(errorLogger.recordBackground.mock.calls[0][1]).toBe('cron:log-cleanup');
  });

  it('SMS_LOGS_RETENTION_DAYS=0 : purge SMS désactivée, les autres journaux continuent', async () => {
    const { service, prisma } = makeService({ SMS_LOGS_RETENTION_DAYS: 0 });
    await service.cleanupLogs();
    expect(prisma.smsLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.wireLog.deleteMany).toHaveBeenCalledTimes(1);
  });
});
