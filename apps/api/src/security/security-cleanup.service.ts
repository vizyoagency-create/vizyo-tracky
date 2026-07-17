import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LOGIN_EVENT_RETENTION_DAYS } from './security.constants';

/**
 * RGPD — purge automatique des positions de connexion (login_events) au-delà de la
 * rétention. Les « zones habituelles » et la carte admin n'utilisent que les données
 * récentes : la purge ne dégrade rien. Tourne chaque nuit (best-effort).
 */
@Injectable()
export class SecurityCleanupService {
  private readonly logger = new Logger(SecurityCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'login-events-purge',
    timeZone: 'Europe/Paris',
  })
  async purgeOldLoginEvents(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - LOGIN_EVENT_RETENTION_DAYS * 24 * 3600 * 1000);
      const res = await this.prisma.loginEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
      if (res.count > 0) {
        this.logger.log(
          `Purge login_events > ${LOGIN_EVENT_RETENTION_DAYS}j : ${res.count} supprimée(s)`,
        );
      }
    } catch (e) {
      this.logger.error(`Purge login_events échouée: ${String(e)}`);
    }
  }
}
