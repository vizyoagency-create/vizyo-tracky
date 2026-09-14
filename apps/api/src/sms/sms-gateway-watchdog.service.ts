import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ErrorLogger } from '../observability/error-logger.service';
import { SmsGatewayService } from './sms-gateway.service';

/**
 * Sentinelle sans coût SMS. Elle interroge chaque minute le relais et le dernier
 * ping Android, puis déduplique les alertes et rappelle une panne prolongée.
 *
 * ══ T44 (contre-expertise du 13/09, P1-2) — HYSTÉRÉSIS ═══════════════════════════════════════
 *
 * Avant : UN tick sain refermait l'épisode et remettait le rappel de 15 min à zéro. Un téléphone
 * qui ne contacte le serveur qu'à son pull de secours (mesuré : 552 s sans ping au repos) passait
 * donc « périmé » puis « sain » à chaque pull — et chaque nouvel épisode écrivait un CRITICAL :
 * jusqu'à 4 par heure, sans panne. Désormais un épisode s'OUVRE après OPEN_AFTER_BAD_TICKS ticks
 * mauvais consécutifs et se FERME après CLOSE_AFTER_GOOD_TICKS ticks sains consécutifs : un pull
 * isolé ne referme rien, un ping manqué n'ouvre rien. Le rappel de 15 min, lui, ne change pas.
 *
 * Un contrôle qui LÈVE (relais injoignable, réponse invalide) compte comme un tick mauvais, avec
 * le même seuil : une panne de contrôle est une panne à annoncer, pas un cas à part.
 */
const OPEN_AFTER_BAD_TICKS = 2;
const CLOSE_AFTER_GOOD_TICKS = 3;
const REMINDER_MS = 15 * 60_000;

@Injectable()
export class SmsGatewayWatchdogService {
  private readonly logger = new Logger(SmsGatewayWatchdogService.name);
  private incidentOpen = false;
  private lastReportAt = 0;
  private badTicks = 0;
  private goodTicks = 0;
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
        this.onGoodTick();
        return;
      }
      const reason =
        health.error ??
        health.gateway?.error ??
        'téléphone Android non vu récemment';
      await this.onBadTick(
        `Passerelle SMS indisponible : ${reason}. Les coupes automatiques sont bloquées par sécurité ; les RESTORE restent prioritaires.`,
        {
          reachable: health.reachable,
          androidState: health.gateway?.device.state ?? null,
          androidFresh: health.gateway?.device.fresh ?? false,
          androidLastSeenAt: health.gateway?.device.freshestLastSeenAt ?? null,
          androidAgeSeconds: health.gateway?.device.ageSeconds ?? null,
          androidDevice: health.gateway?.device.selectedId ?? null,
          relayQueueDepth: health.gateway?.queue.pending ?? null,
        },
      );
    } catch (err) {
      await this.onBadTick(
        `Contrôle de la passerelle SMS impossible : ${err instanceof Error ? err.message : String(err)}`,
        undefined,
      );
    } finally {
      this.running = false;
    }
  }

  private onGoodTick(): void {
    this.badTicks = 0;
    if (!this.incidentOpen) return;
    this.goodTicks += 1;
    if (this.goodTicks < CLOSE_AFTER_GOOD_TICKS) return;
    this.incidentOpen = false;
    this.goodTicks = 0;
    this.lastReportAt = 0;
    this.logger.log(
      `Chaîne Android/SIM de nouveau opérationnelle (${CLOSE_AFTER_GOOD_TICKS} contrôles sains consécutifs)`,
    );
  }

  private async onBadTick(message: string, context: Record<string, unknown> | undefined): Promise<void> {
    this.goodTicks = 0;
    this.badTicks += 1;
    if (!this.incidentOpen && this.badTicks < OPEN_AFTER_BAD_TICKS) {
      this.logger.warn(`${message} — premier contrôle en défaut, confirmation au prochain tick`);
      return;
    }
    if (this.incidentOpen && Date.now() - this.lastReportAt < REMINDER_MS) return;
    this.incidentOpen = true;
    try {
      await this.errorLogger.record(message, 'sms-gateway-watchdog', context, 'CRITICAL');
      this.lastReportAt = Date.now();
    } catch (err) {
      // Jamais « signalé » si le centre d'alerte n'a rien persisté : lastReportAt reste à zéro,
      // le prochain tick retente au lieu d'attendre le rappel de 15 min.
      this.logger.error(
        `Sentinelle passerelle SMS non persistée — retentée au prochain tick : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
