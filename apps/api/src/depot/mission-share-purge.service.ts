import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Espace depot (2026-08), lot A4 — la purge des liens de partage expires.
 *
 * ┌─ POURQUOI ON GARDE 30 JOURS, ET PAS ZERO ─────────────────────────────────┐
 * │ Un lien expire ne donne plus acces a rien : sa ligne pourrait disparaitre   │
 * │ le jour meme. Mais c'est cette ligne qui repond a « qui a ouvert cet acces, │
 * │ quand, et combien de fois a-t-il ete consulte ? » — la question qu'on pose  │
 * │ APRES coup, quand un client s'etonne d'avoir vu passer un camion.           │
 * │                                                                            │
 * │ Trente jours : assez pour instruire, assez court pour ne pas accumuler des  │
 * │ empreintes d'appelants (meme tronquees) sans raison (A4 § 4).               │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Inscrite au catalogue des taches de fond (`background-tasks.service.ts`) sous
 * l'identifiant `mission-share-purge` : rien d'invisible.
 */

/** Duree de conservation apres expiration, pour l'audit. */
export const RETENTION_LIENS_JOURS = 30;

@Injectable()
export class MissionSharePurgeService {
  private readonly logger = new Logger(MissionSharePurgeService.name);
  /** Verrou anti-chevauchement : une purge lente ne doit pas en croiser une autre. */
  private enCours = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Chaque jour a 04:15 — apres les purges de retention, avant l'heure de bureau. */
  @Cron('15 4 * * *', { name: 'mission-share-purge' })
  async tick(): Promise<void> {
    if (this.enCours) return;
    this.enCours = true;
    try {
      const supprimes = await this.purger();
      if (supprimes > 0) this.logger.log(`${supprimes} lien(s) de partage purge(s)`);
    } catch (err) {
      // Une tache de fond qui leve tue l'ordonnanceur pour toutes les suivantes.
      this.logger.error(
        `Purge des liens de partage en echec : ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.enCours = false;
    }
  }

  /** Public : appelable depuis l'inventaire des taches pour un declenchement manuel. */
  async purger(maintenant: Date = new Date()): Promise<number> {
    const plancher = new Date(maintenant.getTime() - RETENTION_LIENS_JOURS * 86_400_000);
    // On purge sur `expiresAt`, pas sur `createdAt` : un lien « fin de mission » cree
    // il y a deux mois pour une mission qui court encore n'est PAS a supprimer.
    const { count } = await this.prisma.missionShareLink.deleteMany({
      where: { expiresAt: { lt: plancher } },
    });
    return count;
  }
}
