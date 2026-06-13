import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Taille de lot pour la purge des positions. La table `positions` est le moteur
 * de croissance de la base (un point par ping de boitier, des millions de lignes
 * par an). On supprime par paquets pour ne JAMAIS prendre un verrou long sur la
 * table pendant que l'ingestion temps reel ecrit dedans.
 */
const POSITIONS_DELETE_BATCH = 10_000;

/**
 * V1.18 — Retention / purge des donnees volumineuses.
 *
 * Deux politiques, toutes deux pilotees par l'env (cf. env.validation.ts) :
 *
 *  - `position_sampling_decisions` (audit-trail du sampling) : retention courte
 *    deja DOCUMENTEE dans le schema Prisma ("purge auto au-dela de 7 jours")
 *    mais dont le cron etait absent. On comble simplement ce trou.
 *    SAMPLING_DECISIONS_RETENTION_DAYS (defaut 7). 0 => desactive.
 *
 *  - `positions` (positions GPS) : DESACTIVE par defaut (POSITIONS_RETENTION_DAYS=0
 *    => retention infinie, comportement historique inchange). Purger les
 *    positions supprime la possibilite de rejouer les anciens trajets sur la
 *    carte : la duree de conservation est une decision metier/legale, on
 *    n'efface donc RIEN tant que l'admin ne fixe pas explicitement la fenetre.
 *    Suppression par lots (10k) pour ne pas verrouiller l'ingestion.
 *
 * Tourne a 3h30 (apres LogCleanupService a 3h00) pour etaler la charge nocturne.
 */
@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Cron('0 30 3 * * *')
  async runRetention(): Promise<void> {
    await this.purgeSamplingDecisions();
    await this.purgePositions();
  }

  /** Purge l'audit-trail des decisions de sampling (defaut 7j). */
  private async purgeSamplingDecisions(): Promise<void> {
    const days = this.config.get('SAMPLING_DECISIONS_RETENTION_DAYS', { infer: true });
    if (days <= 0) return;
    const threshold = new Date(Date.now() - days * DAY_MS);
    const { count } = await this.prisma.positionSamplingDecision.deleteMany({
      where: { receivedAt: { lt: threshold } },
    });
    if (count > 0) {
      this.logger.log(`Sampling decisions purge: ${count} ligne(s) > ${days}j supprimee(s)`);
    }
  }

  /**
   * Purge des positions GPS au-dela de la fenetre de retention, par lots.
   * No-op si POSITIONS_RETENTION_DAYS <= 0 (defaut).
   */
  private async purgePositions(): Promise<void> {
    const days = this.config.get('POSITIONS_RETENTION_DAYS', { infer: true });
    if (days <= 0) return; // 0 = retention infinie (defaut, comportement historique)
    const threshold = new Date(Date.now() - days * DAY_MS);

    let total = 0;
    for (;;) {
      // Prisma `deleteMany` n'accepte pas de LIMIT : on borne via une sous-requete.
      // $1 = threshold (parametre, anti-injection) ; la taille de lot est une
      // constante de confiance inlinee directement dans le SQL.
      const deleted = await this.prisma.$executeRawUnsafe(
        `DELETE FROM positions WHERE id IN (
           SELECT id FROM positions WHERE "timestamp" < $1 LIMIT ${POSITIONS_DELETE_BATCH}
         )`,
        threshold,
      );
      total += deleted;
      if (deleted < POSITIONS_DELETE_BATCH) break;
    }
    if (total > 0) {
      this.logger.log(`Positions purge: ${total} position(s) > ${days}j supprimee(s) par lots`);
    }
  }
}
