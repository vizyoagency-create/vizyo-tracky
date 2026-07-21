import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { assertRetentionWindow, resolvePurgeArmed } from '../common/retention-guard';

/** Taille de lot du DELETE (borne la charge par run, comme la rétention positions). */
const BATCH_SIZE = 5000;
const MAX_BATCHES_PER_RUN = 20;

/**
 * RGPD 4.1 — Rétention des TRAJETS (> `TRIPS_RETENTION_MONTHS`, défaut 12 mois).
 *
 * DRY-RUN par défaut (`TRIPS_PURGE_ENABLED='false'`) : on COMPTE et on TRACE ce qui serait
 * supprimé, sans rien effacer — même prudence que la rétention des positions. Une fois armé,
 * la purge emporte AUSSI `TripAnalysis` et `TripFuelStop` des trajets purgés (narratifs et
 * arrêts localisés — pas de FK en base, nettoyage explicite pour ne pas laisser d'orphelins
 * porteurs de localisation). `Trip.driverId` disparaît avec le trajet : c'est le but (art. 5-e).
 * Chaque run est tracé (catégorie RETENTION) ; toute erreur remonte au centre d'alerte.
 */
@Injectable()
export class TripsRetentionService {
  private readonly logger = new Logger(TripsRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly systemActivity: SystemActivityService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /** 03h45 — après la rétention positions (03h30), avant les purges d'activité (04h15). */
  @Cron('0 45 3 * * *')
  async run(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.errorLogger
        .record(err instanceof Error ? err : new Error(String(err)), 'trips-retention', {}, 'ERROR')
        .catch((e) => this.logger.error('ErrorLogger persist failed', e));
    }
  }

  async runOnce(now: Date = new Date()): Promise<{ mode: 'DISABLED' | 'DRY_RUN' | 'PURGE'; candidates: number; deleted: number }> {
    const months = this.config.get('TRIPS_RETENTION_MONTHS', { infer: true });
    if (!months || months <= 0) {
      this.logger.log('Rétention trajets désactivée (TRIPS_RETENTION_MONTHS=0)');
      return { mode: 'DISABLED', candidates: 0, deleted: 0 };
    }
    // Garde-fou commun : fenêtre effective < 30 j → le job ÉCHOUE (jamais de purge accidentelle).
    assertRetentionWindow(Math.round(months * 30.44), 'trips-retention');
    // Armement : en production le drapeau ne peut PAS désactiver la purge (arrêt d'urgence =
    // TRIPS_RETENTION_MONTHS=0).
    const { armed: purgeEnabled, forced } = resolvePurgeArmed(
      this.config.get('TRIPS_PURGE_ENABLED', { infer: true }),
      this.config.get('NODE_ENV', { infer: true }),
    );
    if (forced) {
      this.logger.warn(
        'TRIPS_PURGE_ENABLED=false IGNORÉ en production : la purge des trajets reste armée ' +
          "(désactivation en développement uniquement ; arrêt d'urgence = TRIPS_RETENTION_MONTHS=0).",
      );
    }

    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - months);
    const candidates = await this.prisma.trip.count({ where: { startedAt: { lt: cutoff } } });

    if (!purgeEnabled) {
      this.logger.log(
        `Rétention trajets DRY-RUN : ${candidates} trajet(s) > ${months} mois seraient supprimés (0 effacé — TRIPS_PURGE_ENABLED=false)`,
      );
      if (candidates > 0) {
        this.systemActivity.record({
          category: 'RETENTION',
          action: 'trips_retention',
          status: 'SKIPPED',
          actor: 'retention-cron',
          target: 'Trajets',
          detail: `DRY-RUN : ${candidates} trajet(s) de plus de ${months} mois (rien n'est effacé tant que la purge n'est pas armée)`,
          meta: { mode: 'DRY_RUN', candidates, months, cutoff: cutoff.toISOString() },
        });
      }
      return { mode: 'DRY_RUN', candidates, deleted: 0 };
    }

    // Purge ARMÉE — par lots, avec nettoyage des tables liées sans FK (analyses IA, arrêts carburant).
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const ids = (
        await this.prisma.trip.findMany({
          where: { startedAt: { lt: cutoff } },
          select: { id: true },
          take: BATCH_SIZE,
        })
      ).map((t) => t.id);
      if (ids.length === 0) break;
      await this.prisma.tripFuelStop.deleteMany({ where: { tripId: { in: ids } } });
      await this.prisma.tripAnalysis.deleteMany({ where: { tripId: { in: ids } } });
      const res = await this.prisma.trip.deleteMany({ where: { id: { in: ids } } });
      deleted += res.count;
    }

    this.logger.log(`Rétention trajets : ${deleted}/${candidates} trajet(s) > ${months} mois supprimés (+ analyses & arrêts liés)`);
    this.systemActivity.record({
      category: 'RETENTION',
      action: 'trips_purged',
      status: 'SUCCESS',
      actor: 'retention-cron',
      target: 'Trajets',
      detail: `${deleted} trajet(s) de plus de ${months} mois supprimés (analyses IA et arrêts carburant liés inclus)`,
      meta: { mode: 'PURGE', candidates, deleted, months, cutoff: cutoff.toISOString() },
    });
    return { mode: 'PURGE', candidates, deleted };
  }
}
