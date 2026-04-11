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
});
