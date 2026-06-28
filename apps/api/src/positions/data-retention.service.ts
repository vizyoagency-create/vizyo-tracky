import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Taille de lot pour la purge des positions. La table `positions` est le moteur de
 * croissance de la base. On supprime par paquets pour ne JAMAIS prendre un verrou long
 * sur la table pendant que l'ingestion temps reel ecrit dedans.
 */
const POSITIONS_DELETE_BATCH = 10_000;

/**
 * Borne anti-emballement : au plus 50 lots (~500k positions) supprimes par run. Si le
 * retard est plus grand, il se resorbe sur plusieurs nuits — on ne sature jamais le VPS
 * (2 vCPU) ni l'ingestion en une seule passe.
 */
const MAX_BATCHES_PER_RUN = 50;

const GLOBAL_SCOPE = 'GLOBAL';

interface RetentionConfig {
  retentionDays: number;
  archiveDays: number;
  purgeEnabled: boolean;
}

interface WindowRow {
  active: number;
  archive: number;
  todelete: number;
  oldest: Date | null;
}

export interface PositionsRetentionResult {
  /** true si POSITIONS_RETENTION_DAYS <= 0 (retention desactivee) ou run skippe. */
  disabled: boolean;
  mode: 'DRY_RUN' | 'REAL';
  retentionDays: number;
  archiveDays: number;
  /** Positions au-dela de (retention+archive) jours = ce qui SERAIT / a ete supprime. */
  toDeleteCount: number;
  /** Positions reellement supprimees ce run (0 en dry-run). */
  deletedCount: number;
  computedAt: Date | null;
}

/**
 * Sprint 6 — Retention & archivage des positions GPS (+ purge du sampling, heritee V1.18).
 *
 * Pipeline positions (ancrage `createdAt`, heure serveur fiable) :
 *   actives (< POSITIONS_RETENTION_DAYS) → archive/preavis [retention, retention+archive]
 *   (encore en base, RECUPERABLES) → suppression au-dela.
 *
 * Le cron CALCULE TOUJOURS un snapshot (global + par flotte) qui alimente les vues de
 * suivi — c'est le DRY-RUN, il n'efface RIEN. La suppression reelle (par lots bornes) n'a
 * lieu QUE si POSITIONS_PURGE_ENABLED='true'. POSITIONS_RETENTION_DAYS=0 desactive tout.
 *
 * Idempotent (recalcul depuis la DB), borne (MAX_BATCHES_PER_RUN), verrou anti-chevauchement.
 * Tourne a 3h30 (apres LogCleanupService a 3h00) pour etaler la charge nocturne.
 */
@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);
  private positionsRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Cron('0 30 3 * * *')
  async runRetention(): Promise<void> {
    await this.purgeSamplingDecisions();
    await this.runPositionsRetention();
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
   * Pipeline de retention des positions. Verrou anti-chevauchement (le run nocturne et un
   * eventuel refresh manuel ne se marchent pas dessus). Ne jette jamais : log + resultat neutre.
   */
  async runPositionsRetention(): Promise<PositionsRetentionResult> {
    if (this.positionsRunning) {
      this.logger.warn('[retention] run precedent encore en cours — skip');
      return this.disabledResult();
    }
    this.positionsRunning = true;
    try {
      return await this.runPositionsRetentionOnce();
    } catch (err) {
      this.logger.error(`[retention] run a echoue: ${err instanceof Error ? err.message : err}`);
      return this.disabledResult();
    } finally {
      this.positionsRunning = false;
    }
  }

  /** Recalcule le snapshot SANS rien supprimer (refresh a la demande, lecture seule). */
  async recomputeSnapshot(): Promise<Date | null> {
    const cfg = this.readConfig();
    if (cfg.retentionDays <= 0) return null;
    const { archiveFrom, deleteFrom } = this.windows(cfg);
    const { computedAt } = await this.computeAndStoreSnapshot(archiveFrom, deleteFrom, cfg);
    return computedAt;
  }

  private async runPositionsRetentionOnce(): Promise<PositionsRetentionResult> {
    const cfg = this.readConfig();
    if (cfg.retentionDays <= 0) {
      // 0 = retention infinie : ni snapshot ni suppression (comportement historique).
      return this.disabledResult();
    }
    const { archiveFrom, deleteFrom } = this.windows(cfg);

    // 1) Snapshot (DRY-RUN) — TOUJOURS. N'efface rien, alimente les vues de suivi.
    const { global, computedAt } = await this.computeAndStoreSnapshot(archiveFrom, deleteFrom, cfg);
    const toDeleteCount = global.todelete;
    const horizon = cfg.retentionDays + cfg.archiveDays;

    // 2) Suppression reelle UNIQUEMENT si le flag est arme.
    if (!cfg.purgeEnabled) {
      this.logger.log(
        `[retention] DRY-RUN : ${toDeleteCount} position(s) > ${horizon}j seraient supprimees ` +
          `(0 effacee — POSITIONS_PURGE_ENABLED=false). actives=${global.active}, archive/preavis=${global.archive}.`,
      );
      return {
        disabled: false,
        mode: 'DRY_RUN',
        retentionDays: cfg.retentionDays,
        archiveDays: cfg.archiveDays,
        toDeleteCount,
        deletedCount: 0,
        computedAt,
      };
    }

    const deletedCount = await this.deletePositionsByBatches(deleteFrom);
    this.logger.log(
      `[retention] SUPPRESSION REELLE : ${deletedCount} position(s) > ${horizon}j supprimee(s) par lots (cible ${toDeleteCount}).`,
    );
    return {
      disabled: false,
      mode: 'REAL',
      retentionDays: cfg.retentionDays,
      archiveDays: cfg.archiveDays,
      toDeleteCount,
      deletedCount,
      computedAt,
    };
  }

  private async deletePositionsByBatches(deleteFrom: Date): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      // Prisma `deleteMany` n'accepte pas de LIMIT : on borne via une sous-requete.
      // $1 = deleteFrom (parametre, anti-injection) ; la taille de lot est une constante
      // de confiance inlinee. SEULE la table `positions` est ciblee (perimetre strict).
      const deleted = await this.prisma.$executeRawUnsafe(
        `DELETE FROM positions WHERE id IN (
           SELECT id FROM positions WHERE "createdAt" < $1 LIMIT ${POSITIONS_DELETE_BATCH}
         )`,
        deleteFrom,
      );
      total += deleted;
      if (deleted < POSITIONS_DELETE_BATCH) break;
    }
    return total;
  }

  private async computeAndStoreSnapshot(
    archiveFrom: Date,
    deleteFrom: Date,
    cfg: RetentionConfig,
  ): Promise<{ global: WindowRow; computedAt: Date }> {
    const computedAt = new Date();
    const horizonMs = (cfg.retentionDays + cfg.archiveDays) * DAY_MS;

    // Global (toutes positions, y compris boitiers sans vehicule).
    const globalRows = await this.prisma.$queryRawUnsafe<WindowRow[]>(
      `SELECT
         count(*) FILTER (WHERE "createdAt" >= $1)::int AS active,
         count(*) FILTER (WHERE "createdAt" < $1 AND "createdAt" >= $2)::int AS archive,
         count(*) FILTER (WHERE "createdAt" < $2)::int AS todelete,
         min("createdAt") AS oldest
       FROM positions`,
      archiveFrom,
      deleteFrom,
    );
    const g: WindowRow = globalRows[0] ?? { active: 0, archive: 0, todelete: 0, oldest: null };

    // Par flotte : positions → tracker → vehicule → flotte. Les positions de boitiers non
    // affectes (sans vehicule) ne sont pas attribuees a une flotte mais restent dans le global.
    const fleetRows = await this.prisma.$queryRawUnsafe<Array<WindowRow & { fleetid: string }>>(
      `SELECT v."fleetId" AS fleetid,
         count(*) FILTER (WHERE p."createdAt" >= $1)::int AS active,
         count(*) FILTER (WHERE p."createdAt" < $1 AND p."createdAt" >= $2)::int AS archive,
         count(*) FILTER (WHERE p."createdAt" < $2)::int AS todelete,
         min(p."createdAt") AS oldest
       FROM positions p
       JOIN trackers t ON t.id = p."trackerId"
       JOIN vehicles v ON v.id = t."vehicleId"
       GROUP BY v."fleetId"`,
      archiveFrom,
      deleteFrom,
    );

    const fleetIds = fleetRows.map((r) => r.fleetid);
    const fleets = fleetIds.length
      ? await this.prisma.fleet.findMany({ where: { id: { in: fleetIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(fleets.map((f) => [f.id, f.name]));
    const nextDeletionAt = (oldest: Date | null): Date | null =>
      oldest ? new Date(oldest.getTime() + horizonMs) : null;

    const rows = [
      {
        scope: GLOBAL_SCOPE,
        fleetName: '',
        activeCount: g.active,
        archiveCount: g.archive,
        toDeleteCount: g.todelete,
        oldestCreatedAt: g.oldest,
        nextDeletionAt: nextDeletionAt(g.oldest),
        computedAt,
      },
      ...fleetRows.map((r) => ({
        scope: r.fleetid,
        fleetName: nameById.get(r.fleetid) ?? '—',
        activeCount: r.active,
        archiveCount: r.archive,
        toDeleteCount: r.todelete,
        oldestCreatedAt: r.oldest,
        nextDeletionAt: nextDeletionAt(r.oldest),
        computedAt,
      })),
    ];

    // Remplacement atomique : les vues lisent toujours un set coherent (pas de fenetre vide).
    await this.prisma.$transaction([
      this.prisma.retentionSnapshot.deleteMany({}),
      this.prisma.retentionSnapshot.createMany({ data: rows }),
    ]);

    return { global: g, computedAt };
  }

  private readConfig(): RetentionConfig {
    return {
      retentionDays: this.config.get('POSITIONS_RETENTION_DAYS', { infer: true }),
      archiveDays: this.config.get('POSITIONS_ARCHIVE_DAYS', { infer: true }),
      purgeEnabled: this.config.get('POSITIONS_PURGE_ENABLED', { infer: true }) === 'true',
    };
  }

  private windows(cfg: RetentionConfig): { archiveFrom: Date; deleteFrom: Date } {
    const now = Date.now();
    return {
      archiveFrom: new Date(now - cfg.retentionDays * DAY_MS),
      deleteFrom: new Date(now - (cfg.retentionDays + cfg.archiveDays) * DAY_MS),
    };
  }

  private disabledResult(): PositionsRetentionResult {
    return {
      disabled: true,
      mode: 'DRY_RUN',
      retentionDays: 0,
      archiveDays: 0,
      toDeleteCount: 0,
      deletedCount: 0,
      computedAt: null,
    };
  }
}
