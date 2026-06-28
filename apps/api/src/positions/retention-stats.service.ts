import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RetentionConfigDto,
  RetentionFleetViewDto,
  RetentionOverviewDto,
  RetentionSnapshotDto,
} from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { DataRetentionService } from './data-retention.service';

const GLOBAL_SCOPE = 'GLOBAL';

interface SnapshotRow {
  scope: string;
  fleetName: string;
  activeCount: number;
  archiveCount: number;
  toDeleteCount: number;
  oldestCreatedAt: Date | null;
  nextDeletionAt: Date | null;
  computedAt: Date;
}

/**
 * Sprint 6 — Lecture des snapshots de retention pour les vues de suivi : super-admin
 * (global + par flotte) et fleet-admin (sa flotte). N'efface RIEN. `refresh()` recalcule
 * le snapshot a la demande (lecture + agregat, AUCUNE suppression).
 */
@Injectable()
export class RetentionStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly retention: DataRetentionService,
  ) {}

  /** Vue super-admin : config + global + toutes les flottes (triees par volume a supprimer). */
  async getOverview(): Promise<RetentionOverviewDto> {
    const snaps = (await this.prisma.retentionSnapshot.findMany()) as SnapshotRow[];
    const global = snaps.find((s) => s.scope === GLOBAL_SCOPE) ?? null;
    const fleets = snaps
      .filter((s) => s.scope !== GLOBAL_SCOPE)
      .sort((a, b) => b.toDeleteCount - a.toDeleteCount || b.activeCount - a.activeCount);
    return {
      config: this.buildConfig(),
      global: this.toDto(global, GLOBAL_SCOPE, 'Global'),
      fleets: fleets.map((s) => this.toDto(s, s.scope, s.fleetName)),
      computedAt: global?.computedAt.toISOString() ?? null,
    };
  }

  /** Vue fleet-admin : config + le snapshot de SA flotte (scope = son fleetId). */
  async getFleetView(fleetId: string | null | undefined): Promise<RetentionFleetViewDto> {
    if (!fleetId) {
      throw new ForbiddenException('Aucune flotte associee a cet utilisateur');
    }
    const snap = (await this.prisma.retentionSnapshot.findUnique({
      where: { scope: fleetId },
    })) as SnapshotRow | null;
    return {
      config: this.buildConfig(),
      snapshot: this.toDto(snap, fleetId, snap?.fleetName ?? ''),
      computedAt: snap?.computedAt.toISOString() ?? null,
    };
  }

  /** Recalcule le snapshot a la demande (super-admin). Lecture seule cote donnees positions. */
  async refresh(): Promise<{ computedAt: string | null }> {
    const computedAt = await this.retention.recomputeSnapshot();
    return { computedAt: computedAt?.toISOString() ?? null };
  }

  private buildConfig(): RetentionConfigDto {
    return {
      retentionDays: this.config.get('POSITIONS_RETENTION_DAYS', { infer: true }),
      archiveDays: this.config.get('POSITIONS_ARCHIVE_DAYS', { infer: true }),
      purgeEnabled: this.config.get('POSITIONS_PURGE_ENABLED', { infer: true }) === 'true',
    };
  }

  private toDto(snap: SnapshotRow | null, scope: string, fleetName: string): RetentionSnapshotDto {
    if (!snap) {
      return {
        scope,
        fleetName,
        activeCount: 0,
        archiveCount: 0,
        toDeleteCount: 0,
        oldestCreatedAt: null,
        nextDeletionAt: null,
      };
    }
    return {
      scope: snap.scope,
      fleetName,
      activeCount: snap.activeCount,
      archiveCount: snap.archiveCount,
      toDeleteCount: snap.toDeleteCount,
      oldestCreatedAt: snap.oldestCreatedAt?.toISOString() ?? null,
      nextDeletionAt: snap.nextDeletionAt?.toISOString() ?? null,
    };
  }
}
