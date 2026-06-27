import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AudioCommandStatus } from '@prisma/client';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';

const MINUTE_MS = 60 * 1000;

/**
 * Sprint 4 — FILET DE SÉCURITÉ auto-disarm de l'écoute audio. CRITIQUE.
 *
 * Le mode monitor du boîtier Coban/Baanool (armé par `monitor<password>`) OUVRE le micro
 * MAIS COUPE le report de position GPS : un véhicule laissé armé « disparaît » de la carte.
 * Ce cron garantit qu'un véhicule n'est JAMAIS laissé en monitor au-delà de la fenêtre
 * `AUDIO_AUTO_DISARM_MINUTES` : il renvoie `tracker<password>` (retour mode track) à toute
 * écoute restée ARMÉE (status=SENT AND disarmedAt IS NULL) dont le `sentAt` dépasse la
 * fenêtre, puis pose `disarmedAt`.
 *
 * DB-DRIVEN (PAS de timer in-process) : l'état vit dans `audio_monitoring_commands`, donc le
 * filet SURVIT à un redémarrage de l'API (un timer setTimeout, lui, serait perdu au reboot →
 * véhicule armé indéfiniment). Verrou anti-chevauchement comme les autres crons
 * (SurveillanceScheduler) : si un tick déborde (beaucoup d'envois SMS), on saute le suivant.
 */
@Injectable()
export class AudioAutoDisarmService {
  private readonly logger = new Logger(AudioAutoDisarmService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly sms: SmsGatewayService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    // Anti-chevauchement : un tick précédent encore en cours (rafale d'envois SMS) → skip.
    // Le travail est repris au tick suivant, ré-évalué depuis la DB (rien n'est perdu).
    if (this.running) {
      this.logger.warn('[auto-disarm] tick précédent encore en cours — skip');
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(
        `[auto-disarm] run a échoué: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<void> {
    // Sans passerelle SMS, on ne peut envoyer aucun désarmement → skip (no-op safe en dev).
    if (!this.sms.isEnabled()) return;

    const windowMin = this.config.get('AUDIO_AUTO_DISARM_MINUTES', { infer: true });
    const threshold = new Date(Date.now() - windowMin * MINUTE_MS);

    // Écoutes ARMÉES restées ouvertes au-delà de la fenêtre. On récupère le tracker (IMEI +
    // SIM) pour l'envoi. Couvert par l'index [status, disarmedAt, sentAt].
    const stale = await this.prisma.audioMonitoringCommand.findMany({
      where: {
        status: AudioCommandStatus.SENT,
        disarmedAt: null,
        sentAt: { lt: threshold },
      },
      select: {
        id: true,
        trackerId: true,
        fleetId: true,
        vehicleId: true,
        tracker: { select: { imei: true, simPhoneNumber: true } },
      },
    });

    if (stale.length === 0) return;

    const pwd = this.config.get('AUDIO_DEVICE_PASSWORD', { infer: true });
    const now = new Date();

    // Regroupe par tracker DISTINCT : un seul SMS `tracker<pwd>` par boîtier même si
    // plusieurs lignes d'audit (déclenchements successifs) sont restées armées. Toutes les
    // lignes du tracker sont ensuite estampillées disarmedAt.
    const byTracker = new Map<string, typeof stale>();
    for (const row of stale) {
      const list = byTracker.get(row.trackerId);
      if (list) list.push(row);
      else byTracker.set(row.trackerId, [row]);
    }

    let disarmed = 0;
    let errors = 0;

    for (const [trackerId, rows] of byTracker) {
      const sim = rows[0].tracker?.simPhoneNumber ?? null;
      const imei = rows[0].tracker?.imei;
      const ids = rows.map((r) => r.id);

      // SIM absente : on ne peut pas envoyer le désarmement → alerte + on N'estampille PAS
      // disarmedAt (la ligne reste « armée » et sera retentée au prochain tick — on ne veut
      // pas masquer un véhicule potentiellement « dark » sur la carte).
      if (!sim) {
        errors++;
        await this.errorLogger
          .record(
            'Auto-disarm impossible : SIM non provisionnée (véhicule potentiellement masqué en monitor)',
            'audio-monitoring',
            { trackerId, imei, fleetId: rows[0].fleetId, vehicleId: rows[0].vehicleId ?? undefined },
            'CRITICAL',
          )
          .catch(() => {});
        continue;
      }

      try {
        const r = await this.sms.send(sim, 'tracker' + pwd, {
          imei,
          source: 'audio-auto-disarm',
        });
        if (r.ok) {
          await this.prisma.audioMonitoringCommand.updateMany({
            where: { id: { in: ids } },
            data: { disarmedAt: now },
          });
          disarmed += ids.length;
          this.logger.log(
            { trackerId, imei, commands: ids.length, windowMin },
            'Auto-disarm: écoute armée expirée désarmée (SMS tracker)',
          );
        } else {
          // Échec passerelle : on N'estampille PAS (retry au prochain tick) + alerte.
          errors++;
          await this.errorLogger
            .record(
              `Auto-disarm: échec envoi SMS tracker : ${r.error ?? 'refus passerelle'}`,
              'audio-monitoring',
              { trackerId, imei, fleetId: rows[0].fleetId, vehicleId: rows[0].vehicleId ?? undefined },
              'CRITICAL',
            )
            .catch(() => {});
        }
      } catch (err) {
        errors++;
        await this.errorLogger
          .record(
            err instanceof Error ? err : new Error(String(err)),
            'audio-monitoring',
            { trackerId, imei, fleetId: rows[0].fleetId, vehicleId: rows[0].vehicleId ?? undefined },
            'CRITICAL',
          )
          .catch(() => {});
      }
    }

    if (disarmed > 0 || errors > 0) {
      this.logger.log(
        `[auto-disarm] tick : disarmed=${disarmed} errors=${errors} / ${byTracker.size} trackers (fenêtre ${windowMin}min)`,
      );
    }
  }
}
