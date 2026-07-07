import { RecurrenceDetectorService } from './recurrence-detector.service';
import type { TripStop } from './trip-stop-detector.service';

const DAY = 24 * 3600 * 1000;

/** Trajet de test : `weekOffset` semaines après la base, départ `startH`h UTC, durée `durH`h, arrivée (lat,lng). */
function trip(
  baseIso: string,
  weekOffset: number,
  startH: number,
  durH: number,
  lat: number,
  lng: number,
  over: { trackerId?: string; startLat?: number; startLng?: number } = {},
) {
  const start = new Date(new Date(baseIso).getTime() + weekOffset * 7 * DAY);
  start.setUTCHours(startH, 0, 0, 0);
  const end = new Date(start.getTime() + durH * 3600 * 1000);
  return {
    vehicleId: 'v1', startedAt: start, endedAt: end, endLat: lat, endLng: lng,
    trackerId: over.trackerId ?? null, startLat: over.startLat ?? 0, startLng: over.startLng ?? 0,
    vehicle: { plate: 'AA-1' },
  };
}

function makePrisma(trips: unknown[], alerts: unknown[] = []) {
  return {
    trip: { findMany: jest.fn().mockResolvedValue(trips) },
    alert: { findMany: jest.fn().mockResolvedValue(alerts) }, // #5 — franchissements géofences
  } as never;
}
function makeGeocode() {
  // Nomme selon la latitude : dépôt Launaguet (43.65), Borderouge (43.63), Ramonville (43.55),
  // Toulouse (>43.5), Carcassonne (<43.5).
  return {
    label: jest.fn().mockImplementation((lat: number) => {
      if (Math.abs(lat - 43.65) < 0.005) return Promise.resolve('Launaguet');
      if (Math.abs(lat - 43.63) < 0.005) return Promise.resolve('Borderouge');
      if (Math.abs(lat - 43.55) < 0.005) return Promise.resolve('Ramonville');
      return Promise.resolve(lat > 43.5 ? 'Toulouse' : 'Carcassonne');
    }),
  } as never;
}
/** Mock du détecteur d'arrêts : deriveStops renvoie `stops` (défaut : aucun → repli sur l'endpoint). */
function makeStops(stops: TripStop[] = []) {
  return { deriveStops: jest.fn().mockResolvedValue(stops) } as never;
}

describe('RecurrenceDetectorService (P3.2 + #3 itinéraire réel)', () => {
  it('sépare 2 destinations récurrentes du même véhicule/jour + géocode, exclut le sous-seuil', async () => {
    const trips: unknown[] = [];
    for (let w = 0; w < 6; w++) trips.push(trip('2026-06-01T00:00:00Z', w, 8, 2, 43.21, 2.35));
    for (let w = 0; w < 5; w++) trips.push(trip('2026-06-01T00:00:00Z', w, 17, 1, 43.60, 1.44));
    for (let w = 0; w < 3; w++) trips.push(trip('2026-06-01T00:00:00Z', w, 12, 1, 44.0, 1.0));

    const svc = new RecurrenceDetectorService(makePrisma(trips), makeGeocode(), makeStops());
    const patterns = await svc.detect('f1');

    expect(patterns.length).toBe(2);
    // Sans arrêts dérivables (mock []) : repli sur le géocodage du point d'arrivée.
    expect(patterns.map((p) => p.destinationLabel).sort()).toEqual(['Carcassonne', 'Toulouse']);
    expect(patterns[0].activeWeeks).toBe(6);
    expect(patterns[0].confidence).toBeCloseTo(0.6, 5);
    expect(patterns[0].endMinutes).toBeGreaterThan(patterns[0].startMinutes);
  });

  it('respecte le plafond d\'enrichissement (0 → aucun géocodage, labels null)', async () => {
    const trips: unknown[] = [];
    for (let w = 0; w < 6; w++) trips.push(trip('2026-06-01T00:00:00Z', w, 8, 2, 43.21, 2.35));
    const geocode = makeGeocode();
    const svc = new RecurrenceDetectorService(makePrisma(trips), geocode, makeStops());

    const patterns = await svc.detect('f1', { maxGeocode: 0 });
    expect(patterns[0].destinationLabel).toBeNull();
    expect(patterns[0].itinerary).toEqual([]);
    expect((geocode as unknown as { label: jest.Mock }).label).not.toHaveBeenCalled();
  });

  it('#3 : aller-retour depuis le dépôt → destination = 1er lieu réel, itinéraire ordonné (dépôt exclu)', async () => {
    // Le véhicule part ET revient à Launaguet (dépôt) chaque lundi, 5 semaines → un motif « → dépôt ».
    const trips: unknown[] = [];
    for (let w = 0; w < 5; w++) {
      trips.push(trip('2026-06-01T00:00:00Z', w, 8, 4, 43.65, 1.48, { trackerId: 'tk1', startLat: 43.65, startLng: 1.48 }));
    }
    // Arrêts RÉELS du trajet représentatif : dépôt (départ), Borderouge (12 min), Ramonville (8 min), dépôt (retour).
    const t0 = new Date('2026-07-06T08:00:00Z').getTime();
    const min = (m: number) => new Date(t0 + m * 60_000);
    const stops: TripStop[] = [
      { lat: 43.65, lng: 1.48, arrivedAt: min(0), leftAt: min(5), durationMin: 5 },    // dépôt
      { lat: 43.63, lng: 1.45, arrivedAt: min(20), leftAt: min(32), durationMin: 12 }, // Borderouge
      { lat: 43.55, lng: 1.47, arrivedAt: min(45), leftAt: min(53), durationMin: 8 },  // Ramonville
      { lat: 43.65, lng: 1.48, arrivedAt: min(70), leftAt: min(80), durationMin: 10 }, // retour dépôt
    ];
    const svc = new RecurrenceDetectorService(makePrisma(trips), makeGeocode(), makeStops(stops));
    const patterns = await svc.detect('f1');

    expect(patterns.length).toBe(1);
    const p = patterns[0];
    expect(p.roundTripFromDepot).toBe(true);
    // Destination = 1er lieu RÉEL (hors dépôt), pas Launaguet.
    expect(p.destinationLabel).toBe('Borderouge');
    expect(p.itinerary).toEqual(['Borderouge', 'Ramonville']);
    expect(p.basis).toContain('itinéraire : Borderouge → Ramonville');
    // Le centroïde « destination » a suivi le 1er arrêt réel.
    expect(p.destLat).toBeCloseTo(43.63, 2);
  });

  it('#5 : trace les zones (géofences) traversées par le trajet type (dédupliquées, ordonnées)', async () => {
    const trips: unknown[] = [];
    for (let w = 0; w < 5; w++) {
      trips.push(trip('2026-06-01T00:00:00Z', w, 8, 3, 43.21, 2.35, { trackerId: 'tk1' }));
    }
    const alerts = [
      { title: 'Sortie de la zone "Toulouse"' },
      { title: 'Entree dans la zone "Carcassonne-centre"' },
      { title: 'Entree dans la zone "Toulouse"' }, // doublon → dédupliqué
    ];
    const svc = new RecurrenceDetectorService(makePrisma(trips, alerts), makeGeocode(), makeStops());
    const patterns = await svc.detect('f1');

    expect(patterns.length).toBe(1);
    expect(patterns[0].zones).toEqual(['Toulouse', 'Carcassonne-centre']);
    expect(patterns[0].basis).toContain('zones : Toulouse, Carcassonne-centre');
  });
});
