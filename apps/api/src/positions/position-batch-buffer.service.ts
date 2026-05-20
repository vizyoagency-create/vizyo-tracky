import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * V1.10 (Sprint 2 perf) — Buffer d'INSERT positions pour ingestion TCP.
 *
 * Avant : chaque trame valide -> 1 transaction Prisma `position.create`.
 *   A 100 vehicules × 6 trames/min = 10 ops/sec = 10 ms latence par insert
 *   = file d'attente TCP qui s'accumule, risque de drop trames sous pic.
 *
 * Maintenant : on accumule les positions a inserer, et on flush en batch via
 * `createMany`. Strategie :
 *   - Flush quand le buffer atteint MAX_BATCH (50 trames) OU quand le timer
 *     periodique FLUSH_INTERVAL_MS expire.
 *   - Si createMany echoue, on log mais on n'arrete pas l'ingestion — les
 *     prochaines trames arriveront et la perte est acceptable (GPS = nature
 *     intrinsequement lossy).
 *
 * Robustesse :
 *   - OnModuleInit : demarre le timer flush.
 *   - OnModuleDestroy : flush final pour ne pas perdre le buffer au shutdown.
 *   - `skipDuplicates: true` au cas ou Postgres retrigger l'insert apres
 *     un timeout transient (defense en profondeur).
 *
 * Note : la denormalisation Tracker.last* + broadcast WS + geofence check
 * + trip processing restent synchrones dans PositionsService.ingest — seule
 * la persistance Position est differee. La derniere position connue reste
 * a jour en temps reel via Tracker.last* (utilise par la carte).
 */

const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH = 50;

@Injectable()
export class PositionBatchBufferService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PositionBatchBufferService.name);
  private buffer: Prisma.PositionCreateManyInput[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush(); // final drain
  }

  /**
   * Ajoute une position au buffer. Non-bloquant (synchrone). Si le buffer
   * atteint MAX_BATCH, declenche un flush immediat en arriere-plan.
   */
  enqueue(data: Prisma.PositionCreateManyInput): void {
    this.buffer.push(data);
    if (this.buffer.length >= MAX_BATCH) {
      void this.flush();
    }
  }

  /**
   * Flush le buffer via un seul `createMany`. Si une fl. en cours, skip
   * (le prochain tick reprendra).
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.buffer.length === 0) return;

    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];

    try {
      const result = await this.prisma.position.createMany({
        data: batch,
        skipDuplicates: true,
      });
      if (result.count !== batch.length) {
        this.logger.warn(
          `Batch insert partial: ${result.count}/${batch.length} inserted (skipDuplicates filtered ${batch.length - result.count})`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Position batch flush failed (${batch.length} positions perdues) : ${err instanceof Error ? err.message : err}`,
      );
      // On ne re-enqueue PAS — sinon en cas d'erreur recurrente le buffer
      // grossit indefiniment. Les prochaines trames repartiront propres.
    } finally {
      this.flushing = false;
    }
  }

  /** Stats pour Observabilite. */
  stats(): { pending: number; flushing: boolean } {
    return { pending: this.buffer.length, flushing: this.flushing };
  }
}
