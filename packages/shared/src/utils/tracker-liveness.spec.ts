import {
  getVehicleConnectivityState,
  GPS_FIX_STALE_THRESHOLD_MS,
  isTrackerOnline,
  TRACKER_ONLINE_THRESHOLD_MS,
} from './tracker-liveness';

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

describe('getVehicleConnectivityState', () => {
  const NOW = new Date('2026-07-08T22:00:00Z').getTime();
  const fresh = NOW - 30_000; // 30 s
  const stalePos = NOW - 29 * 60 * 60 * 1000; // 29 h (incident FS-253)

  it('NOT_CONFIGURED when no tracker', () => {
    expect(getVehicleConnectivityState({ trackerId: null }, NOW)).toBe('NOT_CONFIGURED');
  });

  it('ONLINE when alive with a fresh position', () => {
    expect(
      getVehicleConnectivityState({ trackerId: 't', lastSeenAt: fresh, lastPositionAt: fresh }, NOW),
    ).toBe('ONLINE');
  });

  it('AWAITING_GPS when alive but never had a position (lastPositionAt null)', () => {
    expect(
      getVehicleConnectivityState({ trackerId: 't', lastSeenAt: fresh, lastPositionAt: null }, NOW),
    ).toBe('AWAITING_GPS');
  });

  it('GPS_LOST : alive + fresh no_fix + stale position (FS-253)', () => {
    expect(
      getVehicleConnectivityState(
        { trackerId: 't', lastSeenAt: fresh, lastNoFixAt: fresh, lastPositionAt: stalePos },
        NOW,
      ),
    ).toBe('GPS_LOST');
  });

  it('NOT GPS_LOST (stays ONLINE) when lastNoFixAt is NOT provided — opt-in / backward compat', () => {
    // Un appelant historique qui ne passe pas lastNoFixAt ne doit jamais voir GPS_LOST.
    expect(
      getVehicleConnectivityState({ trackerId: 't', lastSeenAt: fresh, lastPositionAt: stalePos }, NOW),
    ).toBe('ONLINE');
  });

  it('NOT GPS_LOST when the no_fix signal is itself stale (box no longer reporting no_fix)', () => {
    const staleNoFix = NOW - 60 * 60 * 1000; // 1 h -> plus « en train » de reporter sans fix
    expect(
      getVehicleConnectivityState(
        { trackerId: 't', lastSeenAt: fresh, lastNoFixAt: staleNoFix, lastPositionAt: stalePos },
        NOW,
      ),
    ).toBe('ONLINE');
  });

  it('NOT GPS_LOST when the position is still fresh (transient no_fix, e.g. brief tunnel)', () => {
    const recentPos = NOW - 5 * 60 * 1000; // 5 min < seuil 30 min
    expect(
      getVehicleConnectivityState(
        { trackerId: 't', lastSeenAt: fresh, lastNoFixAt: fresh, lastPositionAt: recentPos },
        NOW,
      ),
    ).toBe('ONLINE');
  });

  it('GPS_LOST boundary: position just past the stale threshold', () => {
    const justStale = NOW - (GPS_FIX_STALE_THRESHOLD_MS + 1);
    expect(
      getVehicleConnectivityState(
        { trackerId: 't', lastSeenAt: fresh, lastNoFixAt: fresh, lastPositionAt: justStale },
        NOW,
      ),
    ).toBe('GPS_LOST');
  });

  it('PARKED when silent past threshold with ignition off', () => {
    const silent = NOW - 60 * 60 * 1000; // 1 h
    expect(
      getVehicleConnectivityState(
        { trackerId: 't', lastSeenAt: silent, lastPositionAt: silent, lastIgnition: false },
        NOW,
      ),
    ).toBe('PARKED');
  });

  it('OFFLINE when silent past threshold with ignition on/unknown', () => {
    const silent = NOW - 60 * 60 * 1000;
    expect(
      getVehicleConnectivityState(
        { trackerId: 't', lastSeenAt: silent, lastPositionAt: silent, lastIgnition: true },
        NOW,
      ),
    ).toBe('OFFLINE');
  });
});
