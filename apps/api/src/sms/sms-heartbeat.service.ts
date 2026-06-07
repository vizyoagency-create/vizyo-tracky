import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { SmsGatewayService } from './sms-gateway.service';

export interface HeartbeatResult {
  provider: 'vizyo-texto' | 'twilio' | 'noop';
  recipients: number;
  sent: number;
  failed: number;
  /** true = aucun destinataire configure (SMS_HEARTBEAT_RECIPIENTS vide) => no-op safe. */
  skipped: boolean;
  results: { to: string; ok: boolean; error?: string }[];
}

/**
 * V1.15 — "Preuve de vie" SMS (heartbeat hebdomadaire).
 *
 * vizyo-texto repose sur une SIM Android physique (cf. SmsGatewayService). La
 * chaine peut casser silencieusement : tel decharge, app capcom6 crashee, SIM
 * expiree, operateur qui block... Aujourd'hui on ne le decouvre que le jour ou
 * un SMS CRITICAL part dans le vide (un ErrorLog est cree, mais encore faut-il
 * le regarder).
 *
 * Ce cron envoie chaque lundi 09h00 (Europe/Paris) un SMS de test aux numeros
 * admin (SMS_HEARTBEAT_RECIPIENTS). Si la chaine marche, le SMS arrive ; si elle
 * casse, un ErrorLog CRITICAL `source='sms-heartbeat'` est cree et remonte dans
 * l'admin observability — on sait que la SIM est down avant le prochain incident.
 *
 * L'audit sms_logs et le ErrorLog gateway sont deja geres par
 * SmsGatewayService.send() ; on ajoute juste un ErrorLog CRITICAL dedie au
 * heartbeat pour que l'echec soit explicitement attribue a la preuve de vie
 * (et pas noye dans les echecs SMS metier).
 *
 * L'endpoint admin POST /api/admin/sms/heartbeat/run-now declenche le meme
 * traitement a la demande (debug / validation post-deploiement, sans attendre
 * lundi).
 */
@Injectable()
export class SmsHeartbeatService {
  private readonly logger = new Logger(SmsHeartbeatService.name);

  constructor(
    private readonly sms: SmsGatewayService,
    private readonly errorLogger: ErrorLogger,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Lundi 09h00 Europe/Paris.
   *
   * Le `timeZone` explicite rend le cron independant de la TZ du container API
   * (UTC en prod Docker) : pas besoin de recalculer l'heure en UTC ni de forcer
   * TZ au niveau container.
   */
  @Cron('0 0 9 * * 1', { name: 'sms-heartbeat', timeZone: 'Europe/Paris' })
  async runScheduled(): Promise<void> {
    const result = await this.runHeartbeat();
    if (result.skipped) {
      this.logger.warn('SMS heartbeat skip — SMS_HEARTBEAT_RECIPIENTS vide');
      return;
    }
    this.logger.log(
      `SMS heartbeat via ${result.provider} — ${result.sent}/${result.recipients} OK, ${result.failed} echec(s)`,
    );
  }

  /** Numeros heartbeat depuis l'env (CSV E.164), trimmes et filtres. */
  recipients(): string[] {
    const raw = this.config.get('SMS_HEARTBEAT_RECIPIENTS', { infer: true }) ?? '';
    return raw
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
  }

  /**
   * Coeur du heartbeat — partage par le cron ET l'endpoint run-now.
   *
   * Si aucun destinataire n'est configure, no-op safe (`skipped=true`) : pas
   * d'envoi, pas d'ErrorLog. Pratique en dev ou la var est vide.
   *
   * En mode noop (dev sans gateway), `send()` retourne ok=true et ecrit une
   * ligne d'audit `status='noop'` : le heartbeat "reussit" sans rien envoyer,
   * ce qui est le comportement attendu hors prod.
   */
  async runHeartbeat(): Promise<HeartbeatResult> {
    const provider = this.sms.currentProvider();
    const recipients = this.recipients();

    if (recipients.length === 0) {
      return { provider, recipients: 0, sent: 0, failed: 0, skipped: true, results: [] };
    }

    const ts = new Date().toISOString();
    const body = `[Vizyo Tracky] Heartbeat ${ts} via ${provider} — chaine SMS OK`;

    const results: HeartbeatResult['results'] = [];
    let sent = 0;
    let failed = 0;

    for (const to of recipients) {
      const res = await this.sms.send(to, body, { source: 'sms-heartbeat' });
      results.push({ to, ok: res.ok, error: res.error });
      if (res.ok) {
        sent++;
      } else {
        failed++;
        await this.errorLogger.record(
          `SMS heartbeat ECHEC vers ${to}`,
          'sms-heartbeat',
          { provider, toNumber: to, error: res.error, ts },
          'CRITICAL',
        );
      }
    }

    return { provider, recipients: recipients.length, sent, failed, skipped: false, results };
  }
}
