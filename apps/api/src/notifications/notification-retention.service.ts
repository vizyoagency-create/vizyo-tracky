import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Rétention du journal de notifications (`notification_deliveries`).
 *
 * ── Pourquoi cette purge existe ──────────────────────────────────────────────────────
 * Le centre de notifications trace CHAQUE issue par destinataire, y compris les non-envois
 * — c'est tout son intérêt : une notification retenue doit être aussi visible qu'une
 * notification partie. Mais ça a un coût en volume, et il est massif.
 *
 * Estimation à partir des volumes réels mesurés le 2026-07-27 (~500 alertes/jour) :
 *   - aujourd'hui, périmètre restreint aux 4 super-admins  →  ~2 000 lignes / jour
 *   - une fois ouvert à tous les rôles (~20 destinataires) → ~10 000 lignes / jour,
 *     soit ~300 000 par mois
 *
 * Dont ~94 % de lignes « retenue par préférence » (POWER_CUT + OVERSPEED, coupés par
 * défaut) : toutes identiques, sans valeur passé quelques semaines. Sans purge, la table
 * devient ingérable en quelques mois — et c'est la table qu'on interroge pour répondre
 * « pourquoi je n'ai rien reçu ? », donc la laisser gonfler reviendrait à casser l'outil
 * de diagnostic qu'on vient de construire.
 *
 * ── Deux durées, pas une ─────────────────────────────────────────────────────────────
 * Les lignes n'ont pas la même valeur dans le temps :
 *   - une notification RETENUE (SUPPRESSED/GROUPED) sert à comprendre un silence RÉCENT
 *     (« pourquoi rien reçu hier soir ? ») → 30 jours suffisent largement ;
 *   - une notification ENVOYÉE ou EN ÉCHEC est une trace d'exploitation (« ce client
 *     a-t-il bien été prévenu le 3 du mois ? ») → conservée 180 jours.
 * Et c'est justement la catégorie volumineuse qui est la plus courte : la purge tape
 * là où ça compte sans amputer l'historique utile.
 */

/** Retenues (SUPPRESSED/GROUPED) : volumineuses, utiles seulement à chaud. */
const NOISE_RETENTION_DAYS = 30;
/** Envois réels (SENT/FAILED) : trace d'exploitation, rares, conservées longtemps. */
const DELIVERY_RETENTION_DAYS = 180;

/** Borne par passage : évite un DELETE massif qui verrouillerait la table (VPS 2 vCPU). */
const BATCH_LIMIT = 20_000;

@Injectable()
export class NotificationRetentionService {
  private readonly logger = new Logger(NotificationRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /**
   * 04:45, après la purge des métriques (04:30) et avant le contrôle des sauvegardes
   * (06:00) — créneau déjà creux, on n'ajoute pas de charge concurrente sur un VPS à
   * 2 vCPU déjà identifié comme saturé.
   */
  @Cron('0 45 4 * * *')
  async purge(): Promise<void> {
    try {
      const noise = await this.deleteOlderThan(
        NOISE_RETENTION_DAYS,
        ['SUPPRESSED', 'GROUPED'],
      );
      const delivered = await this.deleteOlderThan(
        DELIVERY_RETENTION_DAYS,
        ['SENT', 'FAILED'],
      );
      if (noise + delivered > 0) {
        this.logger.log(
          `Purge journal notifications : ${noise} retenue(s) > ${NOISE_RETENTION_DAYS} j, ` +
            `${delivered} envoi(s) > ${DELIVERY_RETENTION_DAYS} j.`,
        );
      }
    } catch (e) {
      // Un cron ne doit jamais lever : l'échec est tracé et retenté demain.
      this.logger.error('Purge du journal de notifications échouée', e as Error);
      this.errorLogger.recordBackground(
        e instanceof Error ? e : new Error(String(e)),
        'notifications',
        { phase: 'retention-purge' },
      );
    }
  }

  /** Supprime par lot borné. Renvoie le nombre de lignes effacées. */
  private async deleteOlderThan(days: number, statuses: string[]): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    // `deleteMany` de Prisma n'accepte pas de LIMIT : on borne en sélectionnant d'abord
    // les identifiants. Deux requêtes, mais le verrou reste court et prévisible.
    const doomed = await this.prisma.notificationDelivery.findMany({
      where: { createdAt: { lt: cutoff }, status: { in: statuses } },
      select: { id: true },
      take: BATCH_LIMIT,
    });
    if (doomed.length === 0) return 0;
    const { count } = await this.prisma.notificationDelivery.deleteMany({
      where: { id: { in: doomed.map((d) => d.id) } },
    });
    return count;
  }
}
