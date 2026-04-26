import { distancePointToSegment, isInsideCorridor, parseGeoJsonToDrafts } from './corridor-geometry';

describe('isInsideCorridor', () => {
  // Polyline straight north-south on Greenwich meridian, 1km long.
  const polyline = [
    { lat: 48.85, lng: 2.35 },
    { lat: 48.86, lng: 2.35 },
  ];

  it('returns true for a point exactly on the polyline', () => {
    expect(isInsideCorridor({ lat: 48.855, lng: 2.35 }, polyline, 100)).toBe(true);
  });

  it('returns true within half-width of the polyline', () => {
    // ~30m east of meridian, halfWidth = 50m
    expect(isInsideCorridor({ lat: 48.855, lng: 2.3504 }, polyline, 100)).toBe(true);
  });

  it('returns false beyond half-width of the polyline', () => {
    // ~200m east of meridian, halfWidth = 50m
    expect(isInsideCorridor({ lat: 48.855, lng: 2.353 }, polyline, 100)).toBe(false);
  });

  it('handles polyline with < 2 points gracefully', () => {
    expect(isInsideCorridor({ lat: 48.85, lng: 2.35 }, [{ lat: 48.85, lng: 2.35 }], 100)).toBe(false);
    expect(isInsideCorridor({ lat: 48.85, lng: 2.35 }, [], 100)).toBe(false);
  });

  it('clamps to segment endpoints (no false negatives at corners)', () => {
    // Point past the south end — should still match the closest segment endpoint.
    expect(isInsideCorridor({ lat: 48.849, lng: 2.35 }, polyline, 300)).toBe(true);
  });
});

describe('distancePointToSegment', () => {
  it('returns 0 for a point on the segment', () => {
    const d = distancePointToSegment(
      { lat: 48.855, lng: 2.35 },
      { lat: 48.85, lng: 2.35 },
      { lat: 48.86, lng: 2.35 },
    );
    expect(d).toBeLessThan(1);
  });

  it('measures perpendicular distance correctly', () => {
    const d = distancePointToSegment(
      { lat: 48.855, lng: 2.351 },
      { lat: 48.85, lng: 2.35 },
      { lat: 48.86, lng: 2.35 },
    );
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(100); // ~73m
  });
});

describe('parseGeoJsonToDrafts', () => {
  it('parses a Point Feature with radius into a CIRCLE draft', () => {
    const json = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2.35, 48.85] },
      properties: { name: 'Depot', radius: 250 },
    };
    const drafts = parseGeoJsonToDrafts(json);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual(expect.objectContaining({
      name: 'Depot', type: 'CIRCLE', centerLat: 48.85, centerLng: 2.35, radiusMeters: 250,
    }));
  });

  it('parses a LineString into a CORRIDOR draft', () => {
    const json = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [[2.35, 48.85], [2.40, 48.90], [2.45, 48.92]],
      },
      properties: { name: 'A6', widthM: 150 },
    };
    const drafts = parseGeoJsonToDrafts(json);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.type).toBe('CORRIDOR');
    expect(drafts[0]?.corridorWidthM).toBe(150);
    expect(drafts[0]?.corridorPoints).toHaveLength(3);
  });

  it('parses a FeatureCollection with multiple features', () => {
    const json = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [2.35, 48.85] }, properties: { name: 'A' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[2.35, 48.85], [2.36, 48.86]] }, properties: { name: 'B' } },
      ],
    };
    const drafts = parseGeoJsonToDrafts(json);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.type).toBe('CIRCLE');
    expect(drafts[1]?.type).toBe('CORRIDOR');
  });

  it('falls back to default name and color', () => {
    const json = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2.35, 48.85] },
      properties: {},
    };
    const drafts = parseGeoJsonToDrafts(json);
    expect(drafts[0]?.name).toMatch(/Geofence #/);
    expect(drafts[0]?.color).toBeNull();
  });

  it('returns empty array for unknown input', () => {
    expect(parseGeoJsonToDrafts(null)).toEqual([]);
    expect(parseGeoJsonToDrafts({ foo: 'bar' })).toEqual([]);
  });
});
