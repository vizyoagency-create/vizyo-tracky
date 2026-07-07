import { TripStopDetectorService, type StopPosition } from './trip-stop-detector.service';

const svc = new TripStopDetectorService({} as never);
const T0 = new Date('2026-07-06T08:00:00Z').getTime();
const at = (min: number) => new Date(T0 + min * 60_000);
/** Petit décalage en degrés (~metres) autour d'un point pour simuler le bruit GPS. */
const jit = (base: number, meters: number) => base + meters / 111_320;

// 3 lieux distincts (Launaguet dépôt, Borderouge, Ramonville) — coords fictives mais espacées.
const LAUNAGUET = { lat: 43.65, lng: 1.48 };
const BORDEROUGE = { lat: 43.63, lng: 1.45 };
const RAMONVILLE = { lat: 43.55, lng: 1.47 };

function p(loc: { lat: number; lng: number }, min: number, speed: number, jitterM = 5): StopPosition {
  return { lat: jit(loc.lat, jitterM), lng: jit(loc.lng, jitterM), speedKmh: speed, timestamp: at(min) };
}

describe('TripStopDetectorService.detectStops', () => {
  it('trajet en mouvement continu (aucun arrêt long) -> 0 arrêt', () => {
    const positions: StopPosition[] = [
      p(LAUNAGUET, 0, 30), p(BORDEROUGE, 5, 40), p(RAMONVILLE, 12, 35), p(LAUNAGUET, 20, 25),
    ];
    expect(svc.detectStops(positions)).toHaveLength(0);
  });

  it('un arrêt réel (>=4 min au même endroit) -> 1 arrêt au bon lieu', () => {
    const positions: StopPosition[] = [
      p(LAUNAGUET, 0, 20),
      // Arrêt à Borderouge de la minute 5 à 15 (10 min).
      p(BORDEROUGE, 5, 0), p(BORDEROUGE, 8, 0), p(BORDEROUGE, 12, 1), p(BORDEROUGE, 15, 0),
      p(RAMONVILLE, 25, 30),
    ];
    const stops = svc.detectStops(positions);
    expect(stops).toHaveLength(1);
    expect(stops[0].durationMin).toBe(10);
    expect(Math.abs(stops[0].lat - BORDEROUGE.lat)).toBeLessThan(0.001);
  });

  it('données ÉPARSES (garé : 2 points à 1 h d\'écart au même endroit) -> 1 arrêt long', () => {
    const positions: StopPosition[] = [
      p(BORDEROUGE, 0, 0), p(BORDEROUGE, 60, 0), // heartbeat horaire, même lieu
      p(LAUNAGUET, 75, 40),
    ];
    const stops = svc.detectStops(positions);
    expect(stops).toHaveLength(1);
    expect(stops[0].durationMin).toBe(60);
  });

  it('micro-arrêt (<4 min : feu rouge) -> exclu', () => {
    const positions: StopPosition[] = [
      p(LAUNAGUET, 0, 30),
      p(BORDEROUGE, 5, 0), p(BORDEROUGE, 7, 0), // 2 min seulement
      p(RAMONVILLE, 15, 30),
    ];
    expect(svc.detectStops(positions)).toHaveLength(0);
  });

  it('deux arrêts distincts (Borderouge puis Ramonville) -> 2 arrêts ordonnés', () => {
    const positions: StopPosition[] = [
      p(LAUNAGUET, 0, 25),
      p(BORDEROUGE, 6, 0), p(BORDEROUGE, 12, 0),                // arrêt 1 (6 min)
      p(RAMONVILLE, 20, 30), p(RAMONVILLE, 26, 0), p(RAMONVILLE, 34, 0), // arrêt 2 (8 min)
      p(LAUNAGUET, 45, 40),
    ];
    const stops = svc.detectStops(positions);
    expect(stops).toHaveLength(2);
    expect(stops[0].arrivedAt.getTime()).toBeLessThan(stops[1].arrivedAt.getTime());
    expect(Math.abs(stops[0].lat - BORDEROUGE.lat)).toBeLessThan(0.001);
    expect(Math.abs(stops[1].lat - RAMONVILLE.lat)).toBeLessThan(0.001);
  });
});
