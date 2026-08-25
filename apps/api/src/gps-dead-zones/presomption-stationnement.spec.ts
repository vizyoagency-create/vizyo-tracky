import {
  estHorsChampGps,
  estStationnementPresume,
  estZoneParkingValidee,
  libelleZoneParking,
  SILENCE_HORS_CHAMP_MIN_MS,
} from './presomption-stationnement';

/**
 * TRK-046 — prédicats de la présomption de stationnement.
 *
 * Tous les tests travaillent à INSTANT FIGÉ (leçon TRK-044 : un test qui recalcule « maintenant »
 * avec la fonction testée passe aussi quand elle rend n'importe quoi). `NOW` est un lundi
 * arbitraire ; seuls les ÉCARTS comptent.
 */
const NOW = new Date('2026-08-25T03:00:00.000Z').getTime();
const min = (n: number) => n * 60_000;

const tracker = (over: Record<string, unknown> = {}) => ({
  id: 'tr-1',
  lastSeenAt: new Date(NOW - min(1)),
  lastPositionAt: new Date(NOW - min(90)),
  lastNoFixAt: new Date(NOW - min(1)),
  lastKnownIgnition: true,
  lastLat: 43.6,
  lastLng: 1.44,
  powerLossSuspectAt: null as Date | null,
  ...over,
});

const zoneParking = (over: Record<string, unknown> = {}) => ({
  status: 'CONFIRMED_BENIGN',
  label: 'UNDERGROUND_PARKING',
  placeLabel: null as string | null,
  ...over,
});

describe('estZoneParkingValidee — seule la nature PARKING rend la perte attendue', () => {
  it('accepte parking souterrain et parking couvert bénins', () => {
    expect(estZoneParkingValidee(zoneParking() as never)).toBe(true);
    expect(estZoneParkingValidee(zoneParking({ label: 'COVERED_PARKING' }) as never)).toBe(true);
  });

  it('refuse une zone bénigne NON parking (tunnel), une zone non confirmée, une zone suspecte, et null', () => {
    expect(estZoneParkingValidee(zoneParking({ label: 'TUNNEL' }) as never)).toBe(false);
    expect(estZoneParkingValidee(zoneParking({ status: 'RECURRING' }) as never)).toBe(false);
    expect(estZoneParkingValidee(zoneParking({ status: 'SUSPECT', label: 'JAMMER_SUSPECTED' }) as never)).toBe(false);
    expect(estZoneParkingValidee(null)).toBe(false);
  });
});

describe('estHorsChampGps — deux signatures, et seulement deux', () => {
  it('signature 1 (FZ-862-VY) : trames no_fix fraîches + position périmée = hors champ', () => {
    expect(estHorsChampGps(tracker() as never, NOW)).toBe(true);
  });

  it('signature 2 (parking profond) : silence complet ≥ 90 min avec une position qui existe', () => {
    const t = tracker({
      lastSeenAt: new Date(NOW - SILENCE_HORS_CHAMP_MIN_MS - min(5)),
      lastNoFixAt: null,
      lastPositionAt: new Date(NOW - SILENCE_HORS_CHAMP_MIN_MS - min(5)),
    });
    expect(estHorsChampGps(t as never, NOW)).toBe(true);
  });

  it('un véhicule garé dehors entre deux heartbeats (silence 50 min, position 50 min) N\'EST PAS hors champ', () => {
    // C'est LE cas qui interdit un seuil de silence court : un Coban contact coupé n'émet
    // qu'un heartbeat ~horaire. Le classer hors champ ferait sauter sa coupe programmée
    // pour peu qu'il soit garé à 150 m d'une rampe connue.
    const t = tracker({
      lastSeenAt: new Date(NOW - min(50)),
      lastNoFixAt: null,
      lastKnownIgnition: false,
      lastPositionAt: new Date(NOW - min(50)),
    });
    expect(estHorsChampGps(t as never, NOW)).toBe(false);
  });

  it('un véhicule qui émet des positions fraîches n\'est jamais hors champ', () => {
    const t = tracker({ lastPositionAt: new Date(NOW - min(1)), lastNoFixAt: new Date(NOW - min(3)) });
    expect(estHorsChampGps(t as never, NOW)).toBe(false);
  });

  it('jamais localisé (AWAITING_GPS) ≠ hors champ : pas de position, pas de présomption', () => {
    expect(estHorsChampGps(tracker({ lastPositionAt: null }) as never, NOW)).toBe(false);
  });
});

describe('estStationnementPresume — les trois conditions sont toutes nécessaires', () => {
  it('hors champ + zone parking validée + aucun soupçon = présumé stationné', () => {
    expect(estStationnementPresume(tracker() as never, zoneParking() as never, NOW)).toBe(true);
  });

  it('un soupçon de coupure d\'alimentation (TRK-040) désarme TOUJOURS la présomption', () => {
    const t = tracker({ powerLossSuspectAt: new Date(NOW - min(30)) });
    expect(estStationnementPresume(t as never, zoneParking() as never, NOW)).toBe(false);
  });

  it('sans zone parking validée, jamais de présomption — même hors champ', () => {
    expect(estStationnementPresume(tracker() as never, null, NOW)).toBe(false);
    expect(estStationnementPresume(tracker() as never, zoneParking({ label: 'TUNNEL' }) as never, NOW)).toBe(false);
  });
});

describe('libelleZoneParking', () => {
  it('nomme le lieu géocodé quand il existe, la nature sinon', () => {
    expect(libelleZoneParking(zoneParking() as never)).toBe('parking souterrain');
    expect(libelleZoneParking(zoneParking({ label: 'COVERED_PARKING' }) as never)).toBe('parking couvert');
    expect(libelleZoneParking(zoneParking({ placeLabel: 'Centre commercial' }) as never)).toBe(
      'parking souterrain — Centre commercial',
    );
  });
});
