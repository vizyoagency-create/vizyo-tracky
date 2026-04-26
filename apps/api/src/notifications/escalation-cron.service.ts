import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertSeverity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationDispatchService } from './notification-dispatch.service';

/**
 * V1.5 (Sprint M) — Escalade automatique des alertes CRITICAL non acquittees.
 *
 * Toutes les 5 minutes : recherche les alertes CRITICAL creees il y a > 10 min
 * et non encore acquittees ni escaladees, puis appelle
 * NotificationDispatchService.dispatchEscalation pour notifier les contacts
 * d'escalade (User.escalationContactUserId des FLEET_ADMIN).
 *
 * Marque `Alert.escalatedAt` pour rendre l'operation idempotente.
 */
@Injectable()
export class EscalationCronService {
  private readonly logger = new Logger(EscalationCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async run(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const candidates = await this.prisma.alert.findMany({
      where: {
        severity: AlertSeverity.CRITICAL,
        acknowledgedAt: null,
        escalatedAt: null,
        createdAt: { lt: cutoff },
      },
      include: { vehicle: true },
      take: 100,
    });

    if (candidates.length === 0) return;
    this.logger.log(`Escalating ${candidates.length} unack CRITICAL alerts`);

    for (const alert of candidates) {
      try {
        await this.dispatch.dispatchEscalation(alert);
        await this.prisma.alert.update({
          where: { id: alert.id },
          data: { escalatedAt: new Date() },
        });
      } catch (err) {
        this.logger.warn(
          `Escalation failed for alert ${alert.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
