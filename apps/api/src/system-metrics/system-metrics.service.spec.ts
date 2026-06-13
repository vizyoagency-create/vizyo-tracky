import { SystemMetricsService } from './system-metrics.service';

/**
 * Mock du PrismaService : on différencie les requêtes par leur SQL statique
 * (tagged template) pour renvoyer la bonne forme.
 */
function makePrisma(opts: { growthSpanSec?: number } = {}) {
  const growthSpanSec = opts.growthSpanSec ?? 25 * 3600;
  return {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const q = strings.join(' ');
      if (q.includes('pg_database_size')) return Promise.resolve([{ mb: 2048 }]);
      if (q.includes('pg_stat_user_tables')) {
        return Promise.resolve([
          { table: 'positions', rows: 1_000_000, totalMb: 3400.4, indexMb: 800.2 },
          { table: 'wire_logs', rows: 450_000, totalMb: 1100, indexMb: 200 },
        ]);
      }
      if (q.includes('array_agg')) {
        return Promise.resolve([{ first_mb: 1000, last_mb: 1240, span_sec: growthSpanSec }]);
      }
      return Promise.resolve([]);
    }),
    $queryRawUnsafe: jest.fn(() =>
      Promise.resolve([
        {
          t: new Date('2026-06-14T10:00:00Z'),
          loadAvg1: 1.5,
          cpuPercent: 42,
          memUsedMb: 1200,
          dbSizeMb: 2048,
        },
      ]),
    ),
  };
}

const build = (opts?: { growthSpanSec?: number }) =>
  new SystemMetricsService(makePrisma(opts) as any);

describe('SystemMetricsService', () => {
  it('collectSnapshot renvoie des métriques hôte + taille DB dans des bornes valides', async () => {
    const svc = build();
    const s = await svc.collectSnapshot();
    expect(s.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(s.cpuPercent).toBeLessThanOrEqual(100);
    expect(s.cpuCount).toBeGreaterThan(0);
    expect(s.memTotalMb).toBeGreaterThan(0);
    expect(s.memUsedMb).toBeGreaterThanOrEqual(0);
    expect(s.dbSizeMb).toBe(2048);
    expect(typeof s.loadAvg1).toBe('number');
  });

  it('sampleCpuPercent reste dans [0,100]', async () => {
    const svc = build();
    const pct = await svc.sampleCpuPercent(20);
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  it('getDbStats mappe les tables et extrait le compte positions', async () => {
    const svc = build();
    const r = await svc.getDbStats();
    expect(r.dbSizeMb).toBe(2048);
    expect(r.tables[0].table).toBe('positions');
    expect(r.tables[0].totalMb).toBe(3400.4);
    expect(r.positionsCount).toBe(1_000_000);
    // span 25h >= ~24h -> croissance calculée : (1240-1000)/90000*86400 ≈ 230.4
    expect(r.dbGrowthMbPerDay).toBeCloseTo(230.4, 0);
  });

  it('dbGrowthMbPerDay est null si < ~24h d\'historique', async () => {
    const svc = build({ growthSpanSec: 3600 });
    const r = await svc.getDbStats();
    expect(r.dbGrowthMbPerDay).toBeNull();
  });

  it('getHistory mappe les points et inclut memTotalMb', async () => {
    const svc = build();
    const h = await svc.getHistory('1h');
    expect(h.range).toBe('1h');
    expect(h.memTotalMb).toBeGreaterThan(0);
    expect(h.points.length).toBe(1);
    expect(h.points[0].cpuPercent).toBe(42);
    expect(h.points[0].t).toBe('2026-06-14T10:00:00.000Z');
  });
});
