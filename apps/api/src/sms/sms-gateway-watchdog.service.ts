import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ErrorLogger } from '../observability/error-logger.service';
import { SmsGatewayService } from './sms-gateway.service';

/**
 * Sentinelle sans coût SMS. Elle interroge chaque minute le relais et le dernier
 * ping Android, puis déduplique les alertes et rappelle une panne prolongée.
 */
@Injectable()
export class SmsGatewayWatchdogService {
  private readonly logger = new Logger(SmsGatewayWatchdogService.name);
  private incidentOpen = false;
  private lastReportAt = 0;
  private running = false;

  constructor(
    private readonly sms: SmsGatewayService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  @Cron('0 * * * * *', { name: 'sms-gateway-watchdog' })
  async inspect(): Promise<void> {
    if (this.running || this.sms.currentProvider() !== 'vizyo-texto') return;
    this.running = true;
    try {
      const health = await this.sms.healthCheck();
      const healthy = health.reachable && health.gateway?.operational === true;
      if (healthy) {
        if (this.incidentOpen)
          this.logger.log('Chaîne Android/SIM de nouveau opérationnelle');
        this.incidentOpen = false;
        this.lastReportAt = 0;
        return;
      }
      if (this.incidentOpen && Date.now() - this.lastReportAt < 15 * 60_000)
        return;
      this.incidentOpen = true;
      const reason =
        health.error ??
        health.gateway?.error ??
        'téléphone Android non vu récemment';
      await this.errorLogger.record(
        `Passerelle SMS indisponible : ${reason}. Les coupes automatiques sont bloquées par sécurité ; les RESTORE restent prioritaires.`,
        'sms-gateway-watchdog',
        {
          reachable: health.reachable,
          androidFresh: health.gateway?.device.fresh ?? false,
          androidLastSeenAt: health.gateway?.device.freshestLastSeenAt ?? null,
          androidAgeSeconds: health.gateway?.device.ageSeconds ?? null,
          relayQueueDepth: health.gateway?.queue.pending ?? null,
        },
        'CRITICAL',
      );
      this.lastReportAt = Date.now();
    } catch (err) {
      if (!this.incidentOpen || Date.now() - this.lastReportAt >= 15 * 60_000) {
        this.incidentOpen = true;
        await this.errorLogger.record(
          `Contrôle de la passerelle SMS impossible : ${err instanceof Error ? err.message : String(err)}`,
          'sms-gateway-watchdog',
          undefined,
          'CRITICAL',
        );
        this.lastReportAt = Date.now();
      }
    } finally {
      this.running = false;
    }
  }
}
