import { isTrackerOnline, TRACKER_ONLINE_THRESHOLD_MS } from './tracker-liveness';

describe('tracker-liveness', () => {
  const NOW = new Date('2026-06-13T12:00:00Z').getTime();

  it('offline when lastSeenAt is null/undefined', () => {
    expect(isTrackerOnline(null, NOW)).toBe(false);
    expect(isTrackerOnline(undefined, NOW)).toBe(false);
  });

  it('online within the freshness window', () => {
    expect(isTrackerOnline(new Date(NOW - 60_000), NOW)).toBe(true); // 1 min
    expect(isTrackerOnline(NOW - (TRACKER_ONLINE_THRESHOLD_MS - 1), NOW)).toBe(true);
  });

  it('offline strictly after the threshold', () => {
    expect(isTrackerOnline(NOW - (TRACKER_ONLINE_THRESHOLD_MS + 1), NOW)).toBe(false);
    expect(isTrackerOnline(new Date(NOW - 60 * 60_000), NOW)).toBe(false); // 1 h
  });

  it('boundary: exactly at threshold is still online (inclusive)', () => {
    expect(isTrackerOnline(NOW - TRACKER_ONLINE_THRESHOLD_MS, NOW)).toBe(true);
  });

  it('accepts Date, ISO string and epoch ms', () => {
    const d = new Date(NOW - 60_000);
    expect(isTrackerOnline(d, NOW)).toBe(true);
    expect(isTrackerOnline(d.toISOString(), NOW)).toBe(true);
    expect(isTrackerOnline(d.getTime(), NOW)).toBe(true);
  });

  it('offline on unparseable input', () => {
    expect(isTrackerOnline('not-a-date', NOW)).toBe(false);
  });

  it('treats a future timestamp (clock skew) as online', () => {
    expect(isTrackerOnline(NOW + 5 * 60_000, NOW)).toBe(true);
  });

  it('respects a custom threshold', () => {
    // 2 min depuis le dernier signal, seuil resserré à 1 min -> offline.
    expect(isTrackerOnline(NOW - 2 * 60_000, NOW, 60_000)).toBe(false);
    expect(isTrackerOnline(NOW - 30_000, NOW, 60_000)).toBe(true);
  });
});
