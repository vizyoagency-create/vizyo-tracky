import { Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemMetricsService } from './system-metrics.service';

const RETENTION_DAYS = 30;

/**
 * ══ TRK-060 — UN MESSAGE QUI ENVOIE INSTRUIRE UNE PANNE QUI N'A PAS EU LIEU ══════════════
 *
 * Le 2026-09-02 à minuit, le centre d'alerte a reçu, mot pour mot :
 *
 *     Invalid `prisma.$queryRaw()` invocation:   getaddrinfo EAI_AGAIN tracky-postgres
 *
 * Un lecteur y comprend « la base de données est tombée ». **Elle ne l'était pas** : 1 437 des
 * 1 440 points de la journée ont été collectés normalement, et aucune récidive n'a suivi en
 * 49 heures. Une résolution DNS a échoué le temps d'une tentative, sur UN point de mesure.
 *
 * 🔑 **L'incident était bénin ; le défaut, c'est le message.** Recopier la pile du transport
 * fait porter à l'exploitant tout le travail de traduction — et l'envoie au mauvais endroit, au
 * pire moment. Un message d'alerte doit nommer la DÉPENDANCE, la CONSÉQUENCE, ce qui SURVIT, et
 * l'action s'il y en a une. C'est le patron que `trip-analysis` applique déjà dans ce dépôt.
 *
 * ⚠️ On ne cache rien : le motif technique reste, en fin de phrase et dans le contexte. C'est
 * l'ORDRE qui change — la conséquence d'abord, la pile ensuite.
 */
function decrireEchecCollecte(e: unknown, geste: 'collecte' | 'purge'): string {
  const motif = e instanceof Error ? e.message : String(e);
  // Un échec de résolution de nom vers le service de base : ni la base ni l'application ne sont
  // en cause, et la distinction change complètement l'endroit où l'exploitant va chercher.
  const reseau = /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(motif);
  const quoi = geste === 'collecte'
    ? "Un point de mesure système n'a pas pu être enregistré"
    : "La purge des mesures système de plus de 30 jours n'a pas pu s'exécuter";
  const consequence = geste === 'collecte'
    ? "Un trou d'une minute dans la courbe du VPS ; la collecte reprend au passage suivant."
    : 'Les mesures anciennes restent en base jusqu’au passage suivant.';
  const cause = reseau
    ? "la base de données n'a pas pu être JOINTE (résolution de nom en échec) — ce n'est pas une panne de la base, et rien d'autre n'est dégradé"
    : 'la requête a échoué';
  return `${quoi} : ${cause}. ${consequence} Motif technique : ${motif.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

/**
 * Cron de collecte des métriques système (monitoring VPS).
 * - Toutes les 60s : stocke un snapshot (léger : os + 1 requête metadata DB).
 * - Chaque jour 04:30 : purge les points > 30j (43k lignes max, trivial).
 */
@Injectable()
export class MetricsCollectorService {
  private readonly logger = new Logger(MetricsCollectorService.name);

  constructor(
    private readonly metrics: SystemMetricsService,
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  @Interval(60_000)
  async collect(): Promise<void> {
    try {
      const s = await this.metrics.collectSnapshot();
      await this.prisma.systemMetric.create({
        data: {
          timestamp: new Date(s.timestamp),
          loadAvg1: s.loadAvg1,
          loadAvg5: s.loadAvg5,
          loadAvg15: s.loadAvg15,
          cpuCount: s.cpuCount,
          cpuPercent: s.cpuPercent,
          memUsedMb: s.memUsedMb,
          memTotalMb: s.memTotalMb,
          dbSizeMb: s.dbSizeMb,
        },
      });
    } catch (e) {
      this.logger.error('system metric collect failed', e as Error);
      // TRK-060 — le centre d'alerte reçoit la CONSÉQUENCE, pas la pile de transport brute.
      await this.errorLogger
        .record(decrireEchecCollecte(e, 'collecte'), 'system-metrics', { geste: 'collecte' })
        .catch(() => undefined);
    }
  }

  @Cron('0 30 4 * * *')
  async purge(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    try {
      const { count } = await this.prisma.systemMetric.deleteMany({
        where: { timestamp: { lt: cutoff } },
      });
      if (count > 0) this.logger.log(`Purged ${count} system_metrics > ${RETENTION_DAYS}j`);
    } catch (e) {
      this.logger.error('system metric purge failed', e as Error);
      await this.errorLogger
        .record(decrireEchecCollecte(e, 'purge'), 'system-metrics', { geste: 'purge' })
        .catch(() => undefined);
    }
  }
}
