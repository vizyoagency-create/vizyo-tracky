/**
 * Monitoring VPS (espace admin Tracky) — types partagés API ↔ web.
 *
 * CPU/RAM/load sont lus côté API via le module `os` = niveau HÔTE (loadavg et
 * meminfo ne sont pas isolés par conteneur). Pas de docker.sock, pas de mount.
 */

/** Plages temporelles du dashboard système. */
export type SystemRange = 'live' | '1h' | 'today' | 'yesterday' | '7d' | '30d';

export const SYSTEM_RANGES: readonly SystemRange[] = [
  'live',
  '1h',
  'today',
  'yesterday',
  '7d',
  '30d',
];

/** Snapshot instantané des perfs système. */
export interface SystemSnapshotDto {
  timestamp: string;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  cpuCount: number;
  /** Charge CPU instantanée 0-100 (delta des compteurs os.cpus sur ~200ms). */
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  dbSizeMb: number;
}

/** Un point d'historique (bucket agrégé). */
export interface SystemHistoryPointDto {
  t: string;
  loadAvg1: number;
  cpuPercent: number;
  memUsedMb: number;
  dbSizeMb: number;
}

export interface SystemHistoryDto {
  range: SystemRange;
  memTotalMb: number;
  points: SystemHistoryPointDto[];
}

export interface DbTableStatDto {
  table: string;
  rows: number;
  totalMb: number;
  indexMb: number;
}

/** Stats DB pour la prévision de purge (requêtes metadata, pas de full scan). */
export interface DbStatsDto {
  dbSizeMb: number;
  tables: DbTableStatDto[];
  /** Estimation rapide (pg_stat_user_tables.n_live_tup), pas un count(*). */
  positionsCount: number;
  /** Croissance DB Mo/jour, dérivée des system_metrics si ≥ 24h d'historique, sinon null. */
  dbGrowthMbPerDay: number | null;
}
