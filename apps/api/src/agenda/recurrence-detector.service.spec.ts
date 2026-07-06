import { RecurrenceDetectorService } from './recurrence-detector.service';

const DAY = 24 * 3600 * 1000;

/** Trajet de test : `weekOffset` semaines après la base, départ `startH`h UTC, durée `durH`h, arrivée (lat,lng). */
function trip(baseIso: string, weekOffset: number, startH: number, durH: number, lat: number, lng: number) {
  const start = new Date(new Date(baseIso).getTime() + weekOffset * 7 * DAY);
  start.setUTCHours(startH, 0, 0, 0);
  const end = new Date(start.getTime() + durH * 3600 * 1000);
  return { vehicleId: 'v1', startedAt: start, endedAt: end, endLat: lat, endLng: lng, vehicle: { plate: 'AA-1' } };
}

function makePrisma(trips: unknown[]) {
  return { trip: { findMany: jest.fn().mockResolvedValue(trips) } } as never;
}
function makeGeocode() {
  // Nomme selon la latitude (Toulouse au nord, Carcassonne au sud).
  return { label: jest.fn().mockImplementation((lat: number) => Promise.resolve(lat > 43.5 ? 'Toulouse' : 'Carcassonne')) } as never;
}

describe('RecurrenceDetectorService (P3.2 — récurrence avec destination)', () => {
  it('sépare 2 destinations récurrentes du même véhicule/jour + géocode, exclut le sous-seuil', async () => {
    const trips: unknown[] = [];
    // Destination A (~Carcassonne), le matin, 6 semaines → retenu (confiance 0.6).
    for (let w = 0; w < 6; w++) trips.push(trip('2026-06-01T00:00:00Z', w, 8, 2, 43.21, 2.35));
    // Destination B (~Toulouse), le soir, 5 semaines → retenu (confiance 0.5).
    for (let w = 0; w < 5; w++) trips.push(trip('2026-06-01T00:00:00Z', w, 17, 1, 43.60, 1.44));
    // Destination C, 3 semaines seulement → SOUS le seuil (4), exclu.
    for (let w = 0; w < 3; w++) trips.push(trip('2026-06-01T00:00:00Z', w, 12, 1, 44.0, 1.0));

    const svc = new RecurrenceDetectorService(makePrisma(trips), makeGeocode());
    const patterns = await svc.detect('f1');

    expect(patterns.length).toBe(2);
    expect(patterns.map((p) => p.destinationLabel).sort()).toEqual(['Carcassonne', 'Toulouse']);
    // Trié par confiance décroissante : A (6 semaines) en tête.
    expect(patterns[0].destinationLabel).toBe('Carcassonne');
    expect(patterns[0].activeWeeks).toBe(6);
    expect(patterns[0].confidence).toBeCloseTo(0.6, 5);
    expect(patterns[0].dayOfWeek).toBeGreaterThanOrEqual(1);
    expect(patterns[0].endMinutes).toBeGreaterThan(patterns[0].startMinutes);
  });

  it('respecte le plafond de géocodage (0 → aucun appel, labels null)', async () => {
    const trips: unknown[] = [];
    for (let w = 0; w < 6; w++) trips.push(trip('2026-06-01T00:00:00Z', w, 8, 2, 43.21, 2.35));
    const geocode = makeGeocode();
    const svc = new RecurrenceDetectorService(makePrisma(trips), geocode);

    const patterns = await svc.detect('f1', { maxGeocode: 0 });
    expect(patterns[0].destinationLabel).toBeNull();
    expect((geocode as unknown as { label: jest.Mock }).label).not.toHaveBeenCalled();
  });
});
