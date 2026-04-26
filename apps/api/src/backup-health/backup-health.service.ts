import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';

const STALE_THRESHOLD_MS = 30 * 60 * 60 * 1000; // 30h — backup quotidien donc 30h = 1 backup rate

interface BackupRunPayload {
  status: 'OK' | 'FAILED';
  sizeBytes?: number;
  durationMs?: number;
  destination?: string;
  filename?: string;
  errorMessage?: string;
}

@Injectable()
export class BackupHealthService {
  private readonly logger = new Logger(BackupHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  async record(payload: BackupRunPayload): Promise<{ id: string }> {
    const row = await this.prisma.backupRun.create({
      data: {
        status: payload.status,
        sizeBytes: payload.sizeBytes ? BigInt(payload.sizeBytes) : null,
        durationMs: payload.durationMs ?? null,
        destination: payload.destination ?? null,
        filename: payload.filename ?? null,
        errorMessage: payload.errorMessage ?? null,
      },
    });
    this.logger.log(
      `Backup run recorded: ${payload.status} ${payload.filename ?? ''} (${payload.sizeBytes ?? '?'}B in ${payload.durationMs ?? '?'}ms)`,
    );
    return { id: row.id };
  }

  async lastSuccessfulRun() {
    return this.prisma.backupRun.findFirst({
      where: { status: 'OK' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listRecent(limit = 30) {
    return this.prisma.backupRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  /**
   * V1.5 (Sprint I) — verifie chaque jour a 06:00 UTC qu'un backup a tourne
   * dans les 30 dernieres heures. Sinon, log dans error_logs (visible dans
   * /admin/observability + dashboard global).
   *
   * Le centre d'alertes /admin/alerts (Sprint H3) ne couvre pas (encore) les
   * incidents systeme — il se concentre sur les trackers. L'integration plus
   * profonde se fera Sprint M (alertes avancees).
   */
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async checkBackupHealth(): Promise<void> {
    const last = await this.lastSuccessfulRun();
    const lastTime = last?.createdAt.getTime() ?? 0;
    const ageMs = Date.now() - lastTime;
    if (!last || ageMs > STALE_THRESHOLD_MS) {
      const message = last
        ? `Aucun backup reussi depuis ${(ageMs / 3600000).toFixed(1)}h (dernier: ${last.createdAt.toISOString()})`
        : 'Aucun backup reussi enregistre';
      this.logger.warn(message);
      await this.errorLogger.record(message, 'backup-health', undefined, 'CRITICAL');
    } else {
      this.logger.debug(`Backup health OK (last: ${last.createdAt.toISOString()})`);
    }
  }
}
