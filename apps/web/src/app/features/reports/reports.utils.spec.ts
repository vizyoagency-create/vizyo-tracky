/**
 * Tests Jasmine des helpers du module Rapports.
 *
 * Verrouille les invariants visuels critiques :
 *   - jamais de "-11min" affiche (formatDuration clampe a 0),
 *   - jamais de "9999 km/h" (clampSpeed plafonne a 250),
 *   - les KPI totaux ne sommen jamais des valeurs negatives heritees.
 */
import {
  REPORT_MAX_PLAUSIBLE_SPEED_KMH,
  aggregateKpis,
  clampSpeed,
  formatDuration,
  max0,
} from './reports.utils';

describe('reports.utils — formatDuration', () => {
  it('formats a positive duration in minutes', () => {
    expect(formatDuration(0)).toBe('0min');
    expect(formatDuration(60)).toBe('1min');
    expect(formatDuration(599)).toBe('9min');
    expect(formatDuration(2700)).toBe('45min');
  });

  it('formats a positive duration in hours and minutes', () => {
    expect(formatDuration(3600)).toBe('1h00');
    expect(formatDuration(3661)).toBe('1h01');
    expect(formatDuration(7320)).toBe('2h02');
    expect(formatDuration(36_000)).toBe('10h00');
  });

  it('clamps NEGATIVE durations to "0min" (legacy bug fix)', () => {
    // Le bug prod : -660 secondes affichait "-11min" car
    // Math.floor(-660/60) === -11. Doit afficher "0min".
    expect(formatDuration(-660)).toBe('0min');
    expect(formatDuration(-1)).toBe('0min');
    expect(formatDuration(-999_999)).toBe('0min');
  });

  it('treats NaN / Infinity / null / undefined as 0', () => {
    expect(formatDuration(NaN)).toBe('0min');
    expect(formatDuration(Infinity)).toBe('0min');
    expect(formatDuration(-Infinity)).toBe('0min');
    expect(formatDuration(null)).toBe('0min');
    expect(formatDuration(undefined)).toBe('0min');
  });
});

describe('reports.utils — max0', () => {
  it('returns the value when positive', () => {
    expect(max0(0)).toBe(0);
    expect(max0(1)).toBe(1);
    expect(max0(99999)).toBe(99999);
  });

  it('clamps negatives to 0', () => {
    expect(max0(-1)).toBe(0);
    expect(max0(-1500)).toBe(0);
  });

  it('treats NaN / Infinity / null / undefined as 0', () => {
    expect(max0(NaN)).toBe(0);
    expect(max0(Infinity)).toBe(0);
    expect(max0(-Infinity)).toBe(0);
    expect(max0(null)).toBe(0);
    expect(max0(undefined)).toBe(0);
  });
});

describe('reports.utils — clampSpeed', () => {
  it('returns the value when in [0, 250]', () => {
    expect(clampSpeed(0)).toBe(0);
    expect(clampSpeed(50)).toBe(50);
    expect(clampSpeed(250)).toBe(250);
  });

  it('clamps negatives to 0', () => {
    expect(clampSpeed(-1)).toBe(0);
    expect(clampSpeed(-99)).toBe(0);
  });

  it('caps glitches above 250 km/h', () => {
    expect(clampSpeed(251)).toBe(REPORT_MAX_PLAUSIBLE_SPEED_KMH);
    expect(clampSpeed(9999)).toBe(REPORT_MAX_PLAUSIBLE_SPEED_KMH);
    expect(clampSpeed(Infinity)).toBe(0); // not finite → 0
  });

  it('treats NaN / null / undefined as 0', () => {
    expect(clampSpeed(NaN)).toBe(0);
    expect(clampSpeed(null)).toBe(0);
    expect(clampSpeed(undefined)).toBe(0);
  });
});

describe('reports.utils — aggregateKpis', () => {
  it('returns zeroed KPI for empty list', () => {
    expect(aggregateKpis([])).toEqual({
      tripCount: 0,
      totalDistance: 0,
      totalDuration: 0,
      maxSpeed: 0,
    });
  });

  it('sums healthy trips correctly', () => {
    const kpis = aggregateKpis([
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: 80 },
      { durationSeconds: 300, distanceMeters: 2000, maxSpeed: 110 },
      { durationSeconds: 900, distanceMeters: 8000, maxSpeed: 95 },
    ]);
    expect(kpis.tripCount).toBe(3);
    expect(kpis.totalDistance).toBe(15_000);
    expect(kpis.totalDuration).toBe(1800);
    expect(kpis.maxSpeed).toBe(110);
  });

  it('IGNORES legacy trips with negative duration in totals (bug fix)', () => {
    const kpis = aggregateKpis([
      { durationSeconds: -660, distanceMeters: 24_500, maxSpeed: 133 }, // bug prod
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: 80 },
    ]);
    // -660 NE doit PAS retrancher du total. Total = 0 + 600 = 600.
    expect(kpis.totalDuration).toBe(600);
    // Distance non-impactee.
    expect(kpis.totalDistance).toBe(24_500 + 5000);
  });

  it('ignores negative distances in totals', () => {
    const kpis = aggregateKpis([
      { durationSeconds: 600, distanceMeters: -1500, maxSpeed: 80 },
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: 80 },
    ]);
    expect(kpis.totalDistance).toBe(5000);
  });

  it('caps glitch maxSpeed at 250 km/h', () => {
    const kpis = aggregateKpis([
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: 9999 },
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: 80 },
    ]);
    expect(kpis.maxSpeed).toBe(250);
  });

  it('keeps maxSpeed correct when only negative speeds exist', () => {
    const kpis = aggregateKpis([
      { durationSeconds: 600, distanceMeters: 5000, maxSpeed: -50 },
    ]);
    expect(kpis.maxSpeed).toBe(0);
  });
});
