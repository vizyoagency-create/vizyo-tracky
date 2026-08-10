import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from './error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { assertRetentionWindow } from '../common/retention-guard';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class LogCleanupService {
  private readonly logger = new Logger(LogCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly systemActivity: SystemActivityService,
    @Optional() private readonly errorLogger?: ErrorLogger,
  ) {}

  /** Cron : encapsule `cleanupLogs` — un rejet non rattrape dans un timer tuerait le worker. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runCleanup(): Promise<void> {
    try {
      await this.cleanupLogs();
    } catch (err) {
      this.logger.error(`Log cleanup a échoué: ${err instanceof Error ? err.message : String(err)}`);
      this.errorLogger?.recordBackground(err instanceof Error ? err : new Error(String(err)), 'cron:log-cleanup');
    }
  }

  async cleanupLogs(): Promise<void> {
    // Retention env-configurable (defauts 7j wire / 30j error / 365j mutations).
    const wireDays = this.config.get('WIRE_LOGS_RETENTION_DAYS', { infer: true });
    const errorDays = this.config.get('ERROR_LOGS_RETENTION_DAYS', { infer: true });
    const mutationDays = this.config.get('MUTATION_AUDIT_RETENTION_DAYS', { infer: true });
    // RGPD (lot 1) — journaux SMS : `sms_logs` contient les NUMEROS et le CONTENU des messages
    // (donnees personnelles). Retention 90 j par defaut, 0 = desactive. Garde-fou < 30 j : le job
    // ECHOUE plutot que de purger trop court.
    const smsDays = this.config.get('SMS_LOGS_RETENTION_DAYS', { infer: true });
    assertRetentionWindow(smsDays, 'sms-logs-retention');
    const smsThreshold = new Date(Date.now() - smsDays * DAY_MS);
    const wireThreshold = new Date(Date.now() - wireDays * DAY_MS);
    const errorThreshold = new Date(Date.now() - errorDays * DAY_MS);
    const mutationThreshold = new Date(Date.now() - mutationDays * DAY_MS);

    const [wireResult, errorResult, sysActivityResult, mutationResult, smsResult] = await Promise.all([
      this.prisma.wireLog.deleteMany({
        where: { createdAt: { lt: wireThreshold } },
      }),
      this.prisma.errorLog.deleteMany({
        where: { createdAt: { lt: errorThreshold } },
      }),
      // Palier B — le journal des actions système suit la rétention error logs, SAUF la
      // catégorie MUTATION (audit des mutations HTTP par utilisateur) qui a la sienne,
      // plus longue (valeur d'audit : « qui a fait quoi » doit survivre au journal courant).
      this.prisma.systemActivityLog.deleteMany({
        where: { createdAt: { lt: errorThreshold }, category: { not: 'MUTATION' } },
      }),
      this.prisma.systemActivityLog.deleteMany({
        where: { createdAt: { lt: mutationThreshold }, category: 'MUTATION' },
      }),
      // Journaux SMS (numeros + contenu). smsDays=0 => desactive : on ne supprime rien.
      smsDays > 0
        ? this.prisma.smsLog.deleteMany({ where: { createdAt: { lt: smsThreshold } } })
        : Promise.resolve({ count: 0 }),
    ]);

    const total =
      wireResult.count + errorResult.count + sysActivityResult.count + mutationResult.count + smsResult.count;
    this.logger.log(
      {
        wireDeleted: wireResult.count,
        errorDeleted: errorResult.count,
        sysActivityDeleted: sysActivityResult.count,
        mutationDeleted: mutationResult.count,
        smsDeleted: smsResult.count,
      },
      `Log cleanup: ${wireResult.count} wire logs (>${wireDays}d), ${errorResult.count} error logs (>${errorDays}d), ${sysActivityResult.count} system-activity logs (>${errorDays}d), ${mutationResult.count} mutation-audit (>${mutationDays}d), ${smsResult.count} sms logs (>${smsDays}d) deleted`,
    );

    // La purge du journal est elle-même une action système : sans cette ligne, des
    // entrées qui « disparaissent » de /admin/activity ou /admin/alerts seraient
    // inexplicables. Enregistrée seulement si quelque chose a réellement été purgé.
    if (total > 0) {
      this.systemActivity.record({
        category: 'RETENTION',
        action: 'logs_purged',
        status: 'SUCCESS',
        actor: 'log-cleanup-cron',
        target: `${total} ligne(s) de log`,
        detail: `wire >${wireDays}j, erreurs/système >${errorDays}j, audit mutations >${mutationDays}j, SMS >${smsDays}j`,
        meta: {
          wireDeleted: wireResult.count,
          errorDeleted: errorResult.count,
          sysActivityDeleted: sysActivityResult.count,
          mutationDeleted: mutationResult.count,
          smsDeleted: smsResult.count,
          wireDays,
          errorDays,
          mutationDays,
          smsDays,
        },
      });
    }
  }
}
