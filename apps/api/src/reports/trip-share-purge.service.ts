import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA PURGE DES LIENS DE PARTAGE DE TRAJET
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Un lien expiré ne donne plus accès à rien : sa ligne POURRAIT disparaître à l'instant. On la
 * garde pourtant un mois, et c'est délibéré — « qui a partagé ce trajet, et quand ? » est une
 * question qui se pose APRÈS coup, quand quelqu'un signale avoir reçu un lien qu'il n'aurait
 * pas dû avoir. Supprimer à l'expiration effacerait la seule trace au moment précis où elle
 * devient utile.
 *
 * ⚠️ CALQUÉE SUR `MissionSharePurgeService`, y compris l'heure et le verrou. Deux purges qui
 * feraient la même chose à deux moments différents finiraient par diverger sur la rétention.
 *
 * ⚠️ ON PURGE SUR `expiresAt`, PAS SUR `createdAt`. Un lien de sept jours créé il y a six
 * jours n'est pas à supprimer — il est encore vivant.
 */

/** Durée de conservation APRÈS expiration, pour l'audit. Même valeur que le lot A4. */
export const RETENTION_LIENS_TRAJET_JOURS = 30;

@Injectable()
export class TripSharePurgeService {
  private readonly logger = new Logger(TripSharePurgeService.name);
  /** Verrou anti-chevauchement : une purge lente ne doit pas en croiser une autre. */
  private enCours = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Chaque jour à 04:20 — cinq minutes après celle des liens de mission.
   *
   * ⚠️ DÉCALÉE, PAS SIMULTANÉE : deux `deleteMany` lancés à la même minute sur la même base
   * se disputent les mêmes verrous pour un travail qui n'est pressé ni l'un ni l'autre.
   */
  @Cron('20 4 * * *', { name: 'trip-share-purge' })
  async tick(): Promise<void> {
    if (this.enCours) return;
    this.enCours = true;
    try {
      const supprimes = await this.purger();
      if (supprimes > 0) this.logger.log(`${supprimes} lien(s) de partage de trajet purgé(s)`);
    } catch (err) {
      // Une tâche de fond qui lève tue l'ordonnanceur pour toutes les suivantes.
      this.logger.error(
        `Purge des liens de partage de trajet en échec : ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.enCours = false;
    }
  }

  /** Public : appelable depuis l'inventaire des tâches pour un déclenchement manuel. */
  async purger(maintenant: Date = new Date()): Promise<number> {
    const plancher = new Date(maintenant.getTime() - RETENTION_LIENS_TRAJET_JOURS * 86_400_000);
    const { count } = await this.prisma.tripShareLink.deleteMany({
      where: { expiresAt: { lt: plancher } },
    });
    return count;
  }
}
