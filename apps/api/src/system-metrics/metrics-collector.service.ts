import { Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemMetricsService } from './system-metrics.service';

const RETENTION_DAYS = 30;

/**
 * Cron de collecte des métriques système (monitoring VPS).
 * - Toutes les 60s : stocke un snapshot (léger : os + 1 requête metadata DB).
 * - Chaque jour 04:30 : purge les points > 30j (43k lignes max, trivial).
 */
@Injectable()
export class MetricsCollectorService {
  private readonly logger = new Logger(MetricsCollectorService.name);

  constructor(
    private readonly metrics: SystemMetricsService,
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  @Interval(60_000)
  async collect(): Promise<void> {
    try {
      const s = await this.metrics.collectSnapshot();
      await this.prisma.systemMetric.create({
        data: {
          timestamp: new Date(s.timestamp),
          loadAvg1: s.loadAvg1,
          loadAvg5: s.loadAvg5,
          loadAvg15: s.loadAvg15,
          cpuCount: s.cpuCount,
          cpuPercent: s.cpuPercent,
          memUsedMb: s.memUsedMb,
          memTotalMb: s.memTotalMb,
          dbSizeMb: s.dbSizeMb,
        },
      });
    } catch (e) {
      this.logger.error('system metric collect failed', e as Error);
      await this.errorLogger
        .record(e instanceof Error ? e : new Error(String(e)), 'system-metrics')
        .catch(() => undefined);
    }
  }

  @Cron('0 30 4 * * *')
  async purge(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    try {
      const { count } = await this.prisma.systemMetric.deleteMany({
        where: { timestamp: { lt: cutoff } },
      });
      if (count > 0) this.logger.log(`Purged ${count} system_metrics > ${RETENTION_DAYS}j`);
    } catch (e) {
      this.logger.error('system metric purge failed', e as Error);
      await this.errorLogger
        .record(e instanceof Error ? e : new Error(String(e)), 'system-metrics')
        .catch(() => undefined);
    }
  }
}
