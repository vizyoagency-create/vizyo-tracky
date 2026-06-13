import { Injectable } from '@nestjs/common';
import * as os from 'node:os';
import type {
  DbStatsDto,
  DbTableStatDto,
  SystemHistoryDto,
  SystemRange,
  SystemSnapshotDto,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';

const MB = 1024 * 1024;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Collecte des métriques système (monitoring VPS — espace admin).
 *
 * CPU/RAM/load via `os` : dans un conteneur Docker standard, `os.loadavg()` et
 * `os.totalmem()/freemem()` reflètent l'HÔTE (non isolés par namespace). Donc
 * pas besoin de monter /var/run/docker.sock ni /proc. La taille DB et les
 * tailles de tables viennent de requêtes metadata Postgres (pas de full scan).
 */
@Injectable()
export class SystemMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Échantillonne le CPU% sur une courte fenêtre (delta des compteurs os.cpus). */
  async sampleCpuPercent(windowMs = 200): Promise<number> {
    const a = cpuTimes();
    await new Promise((r) => setTimeout(r, windowMs));
    const b = cpuTimes();
    const idleDelta = b.idle - a.idle;
    const totalDelta = b.total - a.total;
    if (totalDelta <= 0) return 0;
    const pct = (1 - idleDelta / totalDelta) * 100;
    return Math.min(100, Math.max(0, round1(pct)));
  }

  /** Snapshot instantané (host CPU/RAM/load + taille DB). */
  async collectSnapshot(): Promise<SystemSnapshotDto> {
    const load = os.loadavg();
    const cpuPercent = await this.sampleCpuPercent();
    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();
    return {
      timestamp: new Date().toISOString(),
      loadAvg1: round2(load[0] ?? 0),
      loadAvg5: round2(load[1] ?? 0),
      loadAvg15: round2(load[2] ?? 0),
      cpuCount: os.cpus().length,
      cpuPercent,
      memUsedMb: Math.round(memUsed / MB),
      memTotalMb: Math.round(memTotal / MB),
      dbSizeMb: round1(await this.dbSizeMb()),
    };
  }

  private async dbSizeMb(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ mb: number }>>`
      SELECT pg_database_size(current_database())::float8 / ${MB} AS mb`;
    return rows[0]?.mb ?? 0;
  }

  /** Historique agrégé par bucket (epoch-floor, sans extension Timescale). */
  async getHistory(range: SystemRange): Promise<SystemHistoryDto> {
    const { from, to, bucketSec } = rangeParams(range);
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        t: Date;
        loadAvg1: number;
        cpuPercent: number;
        memUsedMb: number;
        dbSizeMb: number;
      }>
    >(
      `SELECT to_timestamp(floor(extract(epoch FROM "timestamp") / $1) * $1) AS t,
              avg("loadAvg1")::float8   AS "loadAvg1",
              avg("cpuPercent")::float8 AS "cpuPercent",
              avg("memUsedMb")::float8  AS "memUsedMb",
              max("dbSizeMb")::float8   AS "dbSizeMb"
       FROM system_metrics
       WHERE "timestamp" >= $2 AND "timestamp" < $3
       GROUP BY 1 ORDER BY 1`,
      bucketSec,
      from,
      to,
    );
    return {
      range,
      memTotalMb: Math.round(os.totalmem() / MB),
      points: rows.map((r) => ({
        t: r.t.toISOString(),
        loadAvg1: round2(r.loadAvg1),
        cpuPercent: round1(r.cpuPercent),
        memUsedMb: Math.round(r.memUsedMb),
        dbSizeMb: round1(r.dbSizeMb),
      })),
    };
  }

  /** Stats DB : tailles tables (metadata) + estimation positions + croissance. */
  async getDbStats(): Promise<DbStatsDto> {
    const [sizeRows, tableRows, growth] = await Promise.all([
      this.dbSizeMb(),
      this.prisma.$queryRaw<
        Array<{ table: string; rows: number; totalMb: number; indexMb: number }>
      >`
        SELECT relname AS "table",
               n_live_tup::int AS rows,
               (pg_total_relation_size(relid)::float8 / ${MB}) AS "totalMb",
               (pg_indexes_size(relid)::float8 / ${MB})       AS "indexMb"
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 15`,
      this.dbGrowthMbPerDay(),
    ]);

    const tables: DbTableStatDto[] = tableRows.map((r) => ({
      table: r.table,
      rows: r.rows,
      totalMb: round1(r.totalMb),
      indexMb: round1(r.indexMb),
    }));
    const positionsCount = tableRows.find((r) => r.table === 'positions')?.rows ?? 0;

    return {
      dbSizeMb: round1(sizeRows),
      tables,
      positionsCount,
      dbGrowthMbPerDay: growth,
    };
  }

  /** Croissance DB Mo/jour à partir des system_metrics (≥ 24h d'historique). */
  private async dbGrowthMbPerDay(): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ first_mb: number; last_mb: number; span_sec: number }>
    >`
      SELECT
        (array_agg("dbSizeMb" ORDER BY "timestamp" ASC))[1]  AS first_mb,
        (array_agg("dbSizeMb" ORDER BY "timestamp" DESC))[1] AS last_mb,
        EXTRACT(EPOCH FROM (max("timestamp") - min("timestamp")))::float8 AS span_sec
      FROM system_metrics
      WHERE "timestamp" > now() - interval '25 hours'`;
    const r = rows[0];
    if (!r || r.span_sec < 24 * 3600 * 0.9) return null; // pas encore ~24h d'historique
    const perDay = ((r.last_mb - r.first_mb) / r.span_sec) * 86400;
    return round1(perDay);
  }
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

function rangeParams(range: SystemRange): { from: Date; to: Date; bucketSec: number } {
  const now = Date.now();
  const DAY = 86_400_000;
  const startOfUtcDay = (ms: number) => {
    const d = new Date(ms);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  };
  switch (range) {
    case 'live':
      return { from: new Date(now - 15 * 60_000), to: new Date(now), bucketSec: 60 };
    case '1h':
      return { from: new Date(now - 3_600_000), to: new Date(now), bucketSec: 120 };
    case 'today':
      return { from: new Date(startOfUtcDay(now)), to: new Date(now), bucketSec: 300 };
    case 'yesterday':
      return {
        from: new Date(startOfUtcDay(now) - DAY),
        to: new Date(startOfUtcDay(now)),
        bucketSec: 600,
      };
    case '7d':
      return { from: new Date(now - 7 * DAY), to: new Date(now), bucketSec: 3_600 };
    case '30d':
      return { from: new Date(now - 30 * DAY), to: new Date(now), bucketSec: 21_600 };
    default:
      return { from: new Date(now - 3_600_000), to: new Date(now), bucketSec: 120 };
  }
}
