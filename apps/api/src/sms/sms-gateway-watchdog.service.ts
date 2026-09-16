import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { COUPE_CIRCUIT_PUSH_EVENT, type CoupeCircuitPushEvent } from '../notifications/coupe-circuit-push.events';
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
/** Push aux super-admins pendant un épisode : ouverture, puis une fois par heure. */
const PUSH_SPACING_MS = 60 * 60_000;

@Injectable()
export class SmsGatewayWatchdogService {
  private readonly logger = new Logger(SmsGatewayWatchdogService.name);
  private incidentOpen = false;
  private lastReportAt = 0;
  private badTicks = 0;
  private goodTicks = 0;
  private running = false;

  /** Push aux super-admins : à l'ouverture de l'épisode, puis une fois par heure tant qu'il dure. */
  private lastPushAt = 0;

  constructor(
    private readonly sms: SmsGatewayService,
    private readonly errorLogger: ErrorLogger,
    private readonly events: EventEmitter2,
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

  /** Événement `coupe-circuit.push` → `CoupeCircuitPushService` (super-admins). Ne lève jamais. */
  private pousser(event: CoupeCircuitPushEvent): void {
    try {
      this.events.emit(COUPE_CIRCUIT_PUSH_EVENT, event);
    } catch (err) {
      this.logger.warn(`push coupe-circuit non émis (${event.kind}) : ${err instanceof Error ? err.message : String(err)}`);
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
    const ouverture = !this.incidentOpen;
    this.incidentOpen = true;
    try {
      await this.errorLogger.record(message, 'sms-gateway-watchdog', context, 'CRITICAL');
      this.lastReportAt = Date.now();
      // Prévenir — le 15/09 le S21 est resté hors ligne de 15:49 à 19:51, CRITICAL au centre
      // d'alerte et personne d'averti. À l'ouverture, puis toutes les heures.
      if (ouverture || Date.now() - this.lastPushAt >= PUSH_SPACING_MS) {
        this.lastPushAt = Date.now();
        this.pousser({
          kind: 'passerelle-sms',
          subjectKey: 'passerelle',
          title: 'Téléphone passerelle SMS hors ligne',
          body: `${message} Brancher / déverrouiller le S21 et ouvrir SMS Gateway.`,
        });
      }
    } catch (err) {
      // Jamais « signalé » si le centre d'alerte n'a rien persisté : lastReportAt reste à zéro,
      // le prochain tick retente au lieu d'attendre le rappel de 15 min.
      this.logger.error(
        `Sentinelle passerelle SMS non persistée — retentée au prochain tick : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
