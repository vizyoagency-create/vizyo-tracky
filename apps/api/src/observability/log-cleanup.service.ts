import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class LogCleanupService {
  private readonly logger = new Logger(LogCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupLogs(): Promise<void> {
    // Retention env-configurable (defauts 7j wire / 30j error). cf. env.validation.
    const wireDays = this.config.get('WIRE_LOGS_RETENTION_DAYS', { infer: true });
    const errorDays = this.config.get('ERROR_LOGS_RETENTION_DAYS', { infer: true });
    const wireThreshold = new Date(Date.now() - wireDays * DAY_MS);
    const errorThreshold = new Date(Date.now() - errorDays * DAY_MS);

    const [wireResult, errorResult, sysActivityResult] = await Promise.all([
      this.prisma.wireLog.deleteMany({
        where: { createdAt: { lt: wireThreshold } },
      }),
      this.prisma.errorLog.deleteMany({
        where: { createdAt: { lt: errorThreshold } },
      }),
      // Palier B — le journal des actions système (arrière-plan) suit la même rétention que les
      // error logs (ERROR_LOGS_RETENTION_DAYS) pour ne pas croître indéfiniment.
      this.prisma.systemActivityLog.deleteMany({
        where: { createdAt: { lt: errorThreshold } },
      }),
    ]);

    this.logger.log(
      { wireDeleted: wireResult.count, errorDeleted: errorResult.count, sysActivityDeleted: sysActivityResult.count },
      `Log cleanup: ${wireResult.count} wire logs (>${wireDays}d), ${errorResult.count} error logs (>${errorDays}d), ${sysActivityResult.count} system-activity logs (>${errorDays}d) deleted`,
    );
  }
}
