import {
  DORMANT_STOP_ACTING_MS,
  DORMANT_STOP_COUNTING_MS,
  formatSilenceLabel,
  getVehicleConnectivityState,
  getVehiclePresenceState,
  GPS_FIX_STALE_THRESHOLD_MS,
  isTrackerOnline,
  isVehicleDormant,
  isVehicleExploited,
  trackerSilenceMs,
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

/**
 * DORMANCE — « ce véhicule fait-il encore partie du parc exploité ? »
 *
 * Les deux tests qui comptent le plus sont les FRONTIÈRES BASSES : un véhicule
 * simplement immobilisé (week-end + pont férié, semaine d'atelier) ne doit JAMAIS
 * être pris pour dormant. Une exclusion à tort retire un vrai véhicule du parc
 * affiché au client — c'est pire que le défaut qu'on corrige.
 */
describe('dormance véhicule', () => {
  const NOW = new Date('2026-07-27T12:00:00Z').getTime();
  const H = 60 * 60 * 1000;
  const J = 24 * H;
  const T = 'tracker-1';

  describe('trackerSilenceMs', () => {
    it('null quand la question n\'a pas de sens (absent ou illisible)', () => {
      expect(trackerSilenceMs(null, NOW)).toBeNull();
      expect(trackerSilenceMs(undefined, NOW)).toBeNull();
      expect(trackerSilenceMs('pas-une-date', NOW)).toBeNull();
    });

    it('mesure le silence et accepte Date / ISO / epoch', () => {
      const d = new Date(NOW - 3 * H);
      expect(trackerSilenceMs(d, NOW)).toBe(3 * H);
      expect(trackerSilenceMs(d.toISOString(), NOW)).toBe(3 * H);
      expect(trackerSilenceMs(d.getTime(), NOW)).toBe(3 * H);
    });

    it('ramène un âge négatif à 0 (horloge boîtier en avance)', () => {
      expect(trackerSilenceMs(NOW + 5 * 60_000, NOW)).toBe(0);
    });
  });

  describe('isVehicleDormant — seuil COMPTAGE (7 j)', () => {
    it('⚠️ un véhicule immobilisé un week-end + pont férié n\'est PAS dormant', () => {
      expect(isVehicleDormant({ trackerId: T, lastSeenAt: NOW - 4 * J }, NOW)).toBe(false);
      expect(isVehicleDormant({ trackerId: T, lastSeenAt: NOW - 6 * J }, NOW)).toBe(false);
    });

    it('dormant au-delà du seuil', () => {
      expect(isVehicleDormant({ trackerId: T, lastSeenAt: NOW - 8 * J }, NOW)).toBe(true);
      // Les deux cas réels de production (52 j et 89 j).
      expect(isVehicleDormant({ trackerId: T, lastSeenAt: NOW - 52 * J }, NOW)).toBe(true);
      expect(isVehicleDormant({ trackerId: T, lastSeenAt: NOW - 89 * J }, NOW)).toBe(true);
    });

    it('frontière STRICTE : pile au seuil, pas encore dormant', () => {
      expect(isVehicleDormant({ trackerId: T, lastSeenAt: NOW - DORMANT_STOP_COUNTING_MS }, NOW)).toBe(false);
      expect(isVehicleDormant({ trackerId: T, lastSeenAt: NOW - DORMANT_STOP_COUNTING_MS - 1 }, NOW)).toBe(true);
    });

    it('⚠️ un véhicule SANS boîtier n\'est pas dormant (c\'est NOT_CONFIGURED)', () => {
      expect(isVehicleDormant({ trackerId: null, lastSeenAt: null }, NOW)).toBe(false);
      expect(isVehicleDormant({ trackerId: undefined }, NOW)).toBe(false);
    });

    it('⚠️ un boîtier qui n\'a JAMAIS émis n\'est pas dormant (il ne s\'est pas « taru »)', () => {
      expect(isVehicleDormant({ trackerId: T, lastSeenAt: null }, NOW)).toBe(false);
    });

    it('une horloge en avance ne rend jamais dormant', () => {
      expect(isVehicleDormant({ trackerId: T, lastSeenAt: NOW + 2 * H }, NOW)).toBe(false);
    });

    it('seuil ACTION (72 h) utilisable explicitement', () => {
      const input = { trackerId: T, lastSeenAt: NOW - 80 * H };
      expect(isVehicleDormant(input, NOW, DORMANT_STOP_ACTING_MS)).toBe(true);
      expect(isVehicleDormant(input, NOW)).toBe(false); // pas encore au seuil de comptage
      expect(isVehicleDormant({ trackerId: T, lastSeenAt: NOW - 71 * H }, NOW, DORMANT_STOP_ACTING_MS)).toBe(false);
    });
  });

  describe('isVehicleExploited — le prédicat des dénominateurs', () => {
    it('exploité quand le boîtier a parlé récemment', () => {
      expect(isVehicleExploited({ trackerId: T, lastSeenAt: NOW - 2 * H }, NOW)).toBe(true);
    });

    it('⚠️ n\'est PAS la négation de isVehicleDormant : sans boîtier, ni l\'un ni l\'autre', () => {
      const sansBoitier = { trackerId: null, lastSeenAt: null };
      expect(isVehicleDormant(sansBoitier, NOW)).toBe(false);
      expect(isVehicleExploited(sansBoitier, NOW)).toBe(false);
    });

    it('écarte d\'un seul appel les non équipés ET les dormants', () => {
      expect(isVehicleExploited({ trackerId: null }, NOW)).toBe(false);              // TEST-001-XX
      expect(isVehicleExploited({ trackerId: T, lastSeenAt: null }, NOW)).toBe(false); // jamais vu
      expect(isVehicleExploited({ trackerId: T, lastSeenAt: NOW - 89 * J }, NOW)).toBe(false); // FV-941-LZ
    });
  });

  describe('formatSilenceLabel', () => {
    it('minutes sous 2 h, heures sous 48 h, puis jours', () => {
      expect(formatSilenceLabel(NOW - 45 * 60_000, NOW)).toBe('45 min');
      expect(formatSilenceLabel(NOW - 5 * H, NOW)).toBe('5 h');
      expect(formatSilenceLabel(NOW - 47 * H, NOW)).toBe('47 h');
      expect(formatSilenceLabel(NOW - 89 * J, NOW)).toBe('89 j');
    });

    it('null quand la question n\'a pas de sens', () => {
      expect(formatSilenceLabel(null, NOW)).toBeNull();
    });
  });

  describe('getVehiclePresenceState — composition avec le tri-état', () => {
    it('DORMANT prime sur PARKED (le silence long n\'est plus une veille normale)', () => {
      const parkedLongtemps = { trackerId: T, lastSeenAt: NOW - 89 * J, lastPositionAt: NOW - 89 * J, lastIgnition: false };
      expect(getVehicleConnectivityState(parkedLongtemps, NOW)).toBe('PARKED');
      expect(getVehiclePresenceState(parkedLongtemps, NOW)).toBe('DORMANT');
    });

    it('DORMANT prime sur OFFLINE', () => {
      const offlineLongtemps = { trackerId: T, lastSeenAt: NOW - 52 * J, lastPositionAt: NOW - 52 * J, lastIgnition: true };
      expect(getVehicleConnectivityState(offlineLongtemps, NOW)).toBe('OFFLINE');
      expect(getVehiclePresenceState(offlineLongtemps, NOW)).toBe('DORMANT');
    });

    it('⚠️ PARKED quelques heures reste PARKED — le cas normal ne bascule pas', () => {
      const gareCeSoir = { trackerId: T, lastSeenAt: NOW - 3 * H, lastPositionAt: NOW - 3 * H, lastIgnition: false };
      expect(getVehiclePresenceState(gareCeSoir, NOW)).toBe('PARKED');
    });

    it('⚠️ NOT_CONFIGURED est préservé : « jamais connecté » n\'est pas « s\'est tu »', () => {
      expect(getVehiclePresenceState({ trackerId: null }, NOW)).toBe('NOT_CONFIGURED');
      expect(getVehiclePresenceState({ trackerId: T, lastSeenAt: null, lastPositionAt: null }, NOW)).toBe('NOT_CONFIGURED');
    });

    it('les états vivants sont intouchés (ils exigent tous un signal < 15 min)', () => {
      const fresh = NOW - 30_000;
      expect(getVehiclePresenceState({ trackerId: T, lastSeenAt: fresh, lastPositionAt: fresh }, NOW)).toBe('ONLINE');
      expect(getVehiclePresenceState({ trackerId: T, lastSeenAt: fresh, lastPositionAt: null }, NOW)).toBe('AWAITING_GPS');
    });

    it('RÉINTÉGRATION AUTOMATIQUE : une seule trame fraîche suffit à sortir de la dormance', () => {
      const dormant = { trackerId: T, lastSeenAt: NOW - 89 * J, lastPositionAt: NOW - 89 * J, lastIgnition: false };
      expect(getVehiclePresenceState(dormant, NOW)).toBe('DORMANT');
      // Le boîtier reparle : rien à cocher, rien à réactiver.
      const reveille = { ...dormant, lastSeenAt: NOW - 10_000, lastPositionAt: NOW - 10_000 };
      expect(getVehiclePresenceState(reveille, NOW)).toBe('ONLINE');
      expect(isVehicleDormant(reveille, NOW)).toBe(false);
      expect(isVehicleExploited(reveille, NOW)).toBe(true);
    });
  });
});
