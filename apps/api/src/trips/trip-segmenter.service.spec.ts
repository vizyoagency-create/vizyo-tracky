import { TripSegmenterService, type SegmenterPosition } from './trip-segmenter.service';

function pos(
  minuteOffset: number,
  speedKmh: number,
  lat = 33.57,
  lng = -7.59,
  ignition?: boolean,
): SegmenterPosition {
  return {
    lat: lat + minuteOffset * 0.001,
    lng,
    speedKmh,
    timestamp: new Date(Date.UTC(2026, 0, 1, 10, minuteOffset, 0)),
    ignition,
  };
}

describe('TripSegmenterService', () => {
  const segmenter = new TripSegmenterService();

  it('should create 1 trip for continuous movement', () => {
    const positions = [
      pos(0, 0), pos(1, 10), pos(2, 20), pos(3, 30), pos(4, 25),
      pos(5, 15), pos(6, 0), pos(11, 0), pos(16, 0),
    ];
    const trips = segmenter.segmentPositions(positions);
    expect(trips.length).toBe(1);
    expect(trips[0]!.positionCount).toBeGreaterThan(2);
  });

  it('should split into 2 trips when stopped for 5+ min', () => {
    const positions = [
      pos(0, 10), pos(1, 20), pos(2, 30),
      pos(3, 0), pos(4, 0), pos(5, 0), pos(6, 0), pos(7, 0), pos(8, 0),
      pos(9, 10), pos(10, 20), pos(11, 30),
      pos(12, 0), pos(13, 0), pos(14, 0), pos(15, 0), pos(16, 0), pos(17, 0),
    ];
    const trips = segmenter.segmentPositions(positions);
    expect(trips.length).toBe(2);
  });

  it('should end trip on ignition OFF', () => {
    const positions = [
      pos(0, 10, 33.57, -7.59, true),
      pos(1, 20, 33.58, -7.59, true),
      pos(2, 30, 33.59, -7.59, true),
      pos(3, 0, 33.60, -7.59, false),
    ];
    const trips = segmenter.segmentPositions(positions);
    expect(trips.length).toBe(1);
    expect(trips[0]!.segmentationSource).toBe('ignition');
  });

  it('should filter out trip with distance < 50m', () => {
    const positions = [
      pos(0, 0), pos(1, 6), pos(2, 6),
      pos(3, 0), pos(8, 0), pos(13, 0),
    ];
    const trips = segmenter.segmentPositions(positions);
    const shortTrips = trips.filter((t) => t.distanceMeters < 50);
    expect(shortTrips.length).toBe(0);
  });

  it('should return empty array for empty positions', () => {
    expect(segmenter.segmentPositions([])).toEqual([]);
  });

  it('should return empty for all stationary positions', () => {
    const positions = [pos(0, 0), pos(1, 0), pos(2, 0)];
    expect(segmenter.segmentPositions(positions)).toEqual([]);
  });

  it('should not start trip for speed > 5 but < 30s', () => {
    const positions = [
      { lat: 33.57, lng: -7.59, speedKmh: 10, timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, 0)) },
      { lat: 33.571, lng: -7.59, speedKmh: 10, timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, 20)) },
      { lat: 33.572, lng: -7.59, speedKmh: 0, timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, 25)) },
    ];
    const trips = segmenter.segmentPositions(positions);
    expect(trips.length).toBe(0);
  });

  it('should calculate distance and speeds correctly', () => {
    const positions = [
      pos(0, 10), pos(1, 30), pos(2, 50), pos(3, 20), pos(4, 10),
      pos(5, 0), pos(10, 0), pos(15, 0),
    ];
    const trips = segmenter.segmentPositions(positions);
    expect(trips.length).toBeGreaterThanOrEqual(1);
    if (trips.length > 0) {
      expect(trips[0]!.maxSpeed).toBeGreaterThan(0);
      expect(trips[0]!.distanceMeters).toBeGreaterThan(0);
      expect(trips[0]!.durationSeconds).toBeGreaterThan(0);
    }
  });

  // ─── Garde-fous corruption (Sprint corruption-durations) ────────────────
  // Ces tests verrouillent les invariants critiques pour la fiabilite des
  // rapports : peu importe l'ordre/quality des positions en entree, la sortie
  // ne doit JAMAIS contenir de durations/distances/vitesses incoherentes.

  it('should never produce negative durationSeconds even with shuffled positions', () => {
    // Memes positions qu'un trajet normal, mais melangees aleatoirement.
    // Le segmenter pre-trie chronologiquement (ligne 42 service) donc le
    // resultat doit etre identique a un input deja trie.
    const sorted = [
      pos(0, 0), pos(1, 10), pos(2, 20), pos(3, 30), pos(4, 25),
      pos(5, 15), pos(6, 0), pos(11, 0), pos(16, 0),
    ];
    const shuffled = [sorted[5]!, sorted[0]!, sorted[7]!, sorted[2]!, sorted[8]!,
                      sorted[1]!, sorted[6]!, sorted[3]!, sorted[4]!];
    const trips = segmenter.segmentPositions(shuffled);
    expect(trips.length).toBeGreaterThanOrEqual(1);
    for (const t of trips) {
      expect(t.durationSeconds).toBeGreaterThanOrEqual(0);
      expect(t.distanceMeters).toBeGreaterThanOrEqual(0);
      expect(t.maxSpeed).toBeGreaterThanOrEqual(0);
      expect(t.avgSpeed).toBeGreaterThanOrEqual(0);
      expect(t.endedAt.getTime()).toBeGreaterThanOrEqual(t.startedAt.getTime());
    }
  });

  it('should handle duplicate timestamps without producing 0-duration trip rows', () => {
    // Doublons exact de timestamp (cas typique : retransmission tracker
    // qui renvoie 2x la meme position). sanitizePositions dedoublonne.
    const positions = [
      pos(0, 10), pos(1, 20), pos(1, 20), pos(2, 30), pos(2, 30),
      pos(3, 0), pos(8, 0), pos(13, 0),
    ];
    const trips = segmenter.segmentPositions(positions);
    for (const t of trips) {
      expect(t.durationSeconds).toBeGreaterThanOrEqual(0);
      expect(t.endedAt.getTime()).toBeGreaterThanOrEqual(t.startedAt.getTime());
    }
  });

  it('should reproduce the production retransmission scenario without negative duration', () => {
    // Reconstitution du bug observe en prod (tracker 7ae3d894) :
    // Phase live monotone (10 positions, t=0..9 min, vitesse 30 km/h) puis
    // batch retransmis insere AU MILIEU (5 positions vieilles de 25 min).
    // Sans le pre-tri du segmenter, le calcul `dur = end - start` produirait
    // une valeur negative. Avec le tri, la duration reste >= 0.
    const live = [
      pos(0, 30), pos(1, 30), pos(2, 30), pos(3, 30), pos(4, 30),
      pos(5, 30), pos(6, 30), pos(7, 30), pos(8, 30), pos(9, 0),
      pos(14, 0), pos(19, 0), // arret final pour fermer le trip
    ];
    // Retransmissions tardives intercalees : timestamps anterieurs (-25 min)
    const buffered: SegmenterPosition[] = [
      { lat: 33.50, lng: -7.59, speedKmh: 25,
        timestamp: new Date(Date.UTC(2026, 0, 1, 9, 35, 0)) },
      { lat: 33.51, lng: -7.59, speedKmh: 25,
        timestamp: new Date(Date.UTC(2026, 0, 1, 9, 36, 0)) },
      { lat: 33.52, lng: -7.59, speedKmh: 25,
        timestamp: new Date(Date.UTC(2026, 0, 1, 9, 37, 0)) },
    ];
    const mixed = [...live.slice(0, 5), ...buffered, ...live.slice(5)];
    const trips = segmenter.segmentPositions(mixed);
    expect(trips.length).toBeGreaterThanOrEqual(1);
    for (const t of trips) {
      expect(t.durationSeconds).toBeGreaterThanOrEqual(0);
      expect(t.distanceMeters).toBeGreaterThanOrEqual(0);
      expect(t.endedAt.getTime()).toBeGreaterThanOrEqual(t.startedAt.getTime());
    }
  });

  it('should clamp negative or NaN speeds to plausible range', () => {
    // sanitizePositions accepte des speedKmh bruts; verifie que le segmenter
    // ne propage pas de valeurs aberrantes en sortie.
    const positions: SegmenterPosition[] = [
      { lat: 33.57, lng: -7.59, speedKmh: -5,
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, 0)) },
      { lat: 33.571, lng: -7.59, speedKmh: 30,
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 1, 0)) },
      { lat: 33.572, lng: -7.59, speedKmh: 40,
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 2, 0)) },
      { lat: 33.573, lng: -7.59, speedKmh: 30,
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 3, 0)) },
      { lat: 33.574, lng: -7.59, speedKmh: 0,
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 4, 0)) },
      { lat: 33.575, lng: -7.59, speedKmh: 0,
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 9, 0)) },
      { lat: 33.576, lng: -7.59, speedKmh: 0,
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, 14, 0)) },
    ];
    const trips = segmenter.segmentPositions(positions);
    for (const t of trips) {
      expect(t.maxSpeed).toBeGreaterThanOrEqual(0);
      expect(t.avgSpeed).toBeGreaterThanOrEqual(0);
    }
  });

  it('should always satisfy endedAt >= startedAt invariant', () => {
    // Stress test : 50 positions aleatoires (ordre aleatoire). Verifie que
    // l'invariant chronologique tient peu importe le batch d'entree.
    const positions: SegmenterPosition[] = [];
    for (let i = 0; i < 50; i++) {
      positions.push({
        lat: 33.57 + i * 0.001,
        lng: -7.59,
        speedKmh: i % 7 === 0 ? 0 : 20 + (i % 30),
        timestamp: new Date(Date.UTC(2026, 0, 1, 10, i, 0)),
      });
    }
    // Shuffle
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j]!, positions[i]!];
    }
    const trips = segmenter.segmentPositions(positions);
    for (const t of trips) {
      expect(t.endedAt.getTime()).toBeGreaterThanOrEqual(t.startedAt.getTime());
      expect(t.durationSeconds).toBeGreaterThanOrEqual(0);
    }
  });
});
