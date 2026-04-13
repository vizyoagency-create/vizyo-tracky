import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LogCleanupService {
  private readonly logger = new Logger(LogCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupLogs(): Promise<void> {
    const wireThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const errorThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [wireResult, errorResult] = await Promise.all([
      this.prisma.wireLog.deleteMany({
        where: { createdAt: { lt: wireThreshold } },
      }),
      this.prisma.errorLog.deleteMany({
        where: { createdAt: { lt: errorThreshold } },
      }),
    ]);

    this.logger.log(
      { wireDeleted: wireResult.count, errorDeleted: errorResult.count },
      `Log cleanup: ${wireResult.count} wire logs (>7d), ${errorResult.count} error logs (>30d) deleted`,
    );
  }
}
