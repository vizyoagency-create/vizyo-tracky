import { RecurrenceDetectorService } from './recurrence-detector.service';
import type { TripStop } from './trip-stop-detector.service';

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;

/**
 * Base d'apprentissage ANCRÉE SUR MAINTENANT (— 6 semaines), et non sur une date en dur.
 * Depuis la garde de RÉCENCE des motifs, un jeu d'essai figé au calendrier périmerait tout seul :
 * les mêmes trajets, joués un mois plus tard, deviendraient une habitude éteinte et les tests
 * échoueraient sans qu'une ligne de code ait bougé.
 */
const BASE_ISO = new Date(Date.now() - 6 * WEEK).toISOString();

/** Trajet de test : `weekOffset` semaines après la base, départ `startH`h UTC, durée `durH`h, arrivée (lat,lng). */
function trip(
  baseIso: string,
  weekOffset: number,
  startH: number,
  durH: number,
  lat: number,
  lng: number,
  over: {
    trackerId?: string;
    startLat?: number;
    startLng?: number;
    vehicleId?: string;
    /** Boîtier du véhicule tel que joint par la requête (absent = véhicule non équipé). */
    tracker?: { id: string; lastSeenAt: Date | null } | null;
  } = {},
) {
  const start = new Date(new Date(baseIso).getTime() + weekOffset * 7 * DAY);
  start.setUTCHours(startH, 0, 0, 0);
  const end = new Date(start.getTime() + durH * 3600 * 1000);
  return {
    vehicleId: over.vehicleId ?? 'v1', startedAt: start, endedAt: end, endLat: lat, endLng: lng,
    trackerId: over.trackerId ?? null, startLat: over.startLat ?? 0, startLng: over.startLng ?? 0,
    vehicle: { plate: 'AA-1', tracker: over.tracker ?? null },
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
/** Détecteur d'arrêts en PANNE (ex. lecture Position échoue) → doit être remonté au centre d'alerte. */
const makeStopsThrows = () => ({ deriveStops: jest.fn().mockRejectedValue(new Error('DB positions HS')) } as never);
const makeErrors = () => ({ record: jest.fn().mockResolvedValue('log-1') } as never);

describe('RecurrenceDetectorService (P3.2 + #3 itinéraire réel)', () => {
  it('sépare 2 destinations récurrentes du même véhicule/jour + géocode, exclut le sous-seuil', async () => {
    const trips: unknown[] = [];
    for (let w = 0; w < 6; w++) trips.push(trip(BASE_ISO, w, 8, 2, 43.21, 2.35));
    for (let w = 0; w < 5; w++) trips.push(trip(BASE_ISO, w, 17, 1, 43.60, 1.44));
    for (let w = 0; w < 3; w++) trips.push(trip(BASE_ISO, w, 12, 1, 44.0, 1.0));

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
    for (let w = 0; w < 6; w++) trips.push(trip(BASE_ISO, w, 8, 2, 43.21, 2.35));
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
      trips.push(trip(BASE_ISO, w, 8, 4, 43.65, 1.48, { trackerId: 'tk1', startLat: 43.65, startLng: 1.48 }));
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

  it('capture : un échec de deriveStops est remonté au centre d\'alerte (AGENDA_RECURRENCE) sans casser l\'analyse', async () => {
    const trips: unknown[] = [];
    for (let w = 0; w < 5; w++) {
      trips.push(trip(BASE_ISO, w, 8, 3, 43.21, 2.35, { trackerId: 'tk1' }));
    }
    const errors = makeErrors();
    const svc = new RecurrenceDetectorService(makePrisma(trips), makeGeocode(), makeStopsThrows(), errors);
    const patterns = await svc.detect('f1'); // ne throw pas : repli sur le géocodage du point d'arrivée

    expect(patterns.length).toBe(1);
    expect(patterns[0].destinationLabel).toBe('Carcassonne'); // fallback endpoint (lat 43.21)
    expect((errors as unknown as { record: jest.Mock }).record).toHaveBeenCalledWith(
      expect.any(Error),
      'AGENDA_RECURRENCE',
      expect.objectContaining({ trackerId: 'tk1', phase: 'deriveStops' }),
    );
  });

  it('#5 : trace les zones (géofences) traversées par le trajet type (dédupliquées, ordonnées)', async () => {
    const trips: unknown[] = [];
    for (let w = 0; w < 5; w++) {
      trips.push(trip(BASE_ISO, w, 8, 3, 43.21, 2.35, { trackerId: 'tk1' }));
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

  /**
   * VIVACITÉ. Un motif se déduit d'un passé qui, lui, ne bouge plus : sans garde, un véhicule mort
   * depuis 89 jours (cas réel : FV-941-LZ) « justifie » encore une réservation ferme la semaine
   * prochaine. Deux gardes indépendantes — le véhicule (boîtier muet > 72 h) et le motif (dernière
   * occurrence > 3 semaines) — parce qu'un véhicule bien vivant peut avoir abandonné une tournée.
   */
  describe('gardes de vivacité (dormance véhicule + récence du motif)', () => {
    const H = 3600 * 1000;
    const heard = (ms: number | null) => ({ id: 'tk1', lastSeenAt: ms == null ? null : new Date(Date.now() - ms) });
    /** 5 semaines consécutives du même trajet, la dernière `lastWeeksAgo` semaines avant maintenant. */
    function weekly(lastWeeksAgo: number, over: Parameters<typeof trip>[6] = {}) {
      const base = new Date(Date.now() - (lastWeeksAgo + 4) * WEEK).toISOString();
      const out: unknown[] = [];
      for (let w = 0; w < 5; w++) out.push(trip(base, w, 8, 2, 43.21, 2.35, over));
      return out;
    }

    it('boîtier muet depuis 89 j : plus aucun motif, et l’exclusion est COMPTÉE', async () => {
      const svc = new RecurrenceDetectorService(makePrisma(weekly(1, { tracker: heard(89 * 24 * H) })), makeGeocode(), makeStops());
      const res = await svc.detectWithStats('f1');
      expect(res.patterns).toEqual([]);
      expect(res.skippedDormantVehicles).toBe(1); // compté UNE fois, pas une fois par trajet
      expect(res.skippedStalePatterns).toBe(0);
    });

    it('silence de 2 h : le motif reste (un véhicule garé se tait aussi)', async () => {
      const svc = new RecurrenceDetectorService(makePrisma(weekly(1, { tracker: heard(2 * H) })), makeGeocode(), makeStops());
      const res = await svc.detectWithStats('f1');
      expect(res.patterns.length).toBe(1);
      expect(res.skippedDormantVehicles).toBe(0);
    });

    it('véhicule SANS boîtier : jamais écarté (il n’a pas « cessé » d’émettre)', async () => {
      const svc = new RecurrenceDetectorService(makePrisma(weekly(1, { tracker: null })), makeGeocode(), makeStops());
      const res = await svc.detectWithStats('f1');
      expect(res.patterns.length).toBe(1);
      expect(res.skippedDormantVehicles).toBe(0);
    });

    it('boîtier qui n’a JAMAIS émis : pas dormant non plus (NOT_CONFIGURED ≠ s’est tu)', async () => {
      const svc = new RecurrenceDetectorService(makePrisma(weekly(1, { tracker: heard(null) })), makeGeocode(), makeStops());
      const res = await svc.detectWithStats('f1');
      expect(res.patterns.length).toBe(1);
      expect(res.skippedDormantVehicles).toBe(0);
    });

    it('réintégration : le même historique redevient un motif dès que le boîtier reparle', async () => {
      const muet = new RecurrenceDetectorService(makePrisma(weekly(1, { tracker: heard(80 * H) })), makeGeocode(), makeStops());
      expect((await muet.detectWithStats('f1')).patterns).toEqual([]);

      const revenu = new RecurrenceDetectorService(makePrisma(weekly(1, { tracker: heard(60_000) })), makeGeocode(), makeStops());
      const res = await revenu.detectWithStats('f1');
      expect(res.patterns.length).toBe(1);
      expect(res.skippedDormantVehicles).toBe(0);
    });

    it('véhicule vivant mais tournée ARRÊTÉE il y a 5 semaines : motif écarté et compté', async () => {
      const svc = new RecurrenceDetectorService(makePrisma(weekly(5, { tracker: heard(10 * 60_000) })), makeGeocode(), makeStops());
      const res = await svc.detectWithStats('f1');
      expect(res.patterns).toEqual([]);
      expect(res.skippedStalePatterns).toBe(1);
      expect(res.skippedDormantVehicles).toBe(0); // le véhicule roule, c'est l'HABITUDE qui est morte
    });

    it('deux semaines d’interruption (congés) : le motif survit', async () => {
      const svc = new RecurrenceDetectorService(makePrisma(weekly(2, { tracker: heard(10 * 60_000) })), makeGeocode(), makeStops());
      const res = await svc.detectWithStats('f1');
      expect(res.patterns.length).toBe(1);
      expect(res.skippedStalePatterns).toBe(0);
    });

    it('un dormant n’emporte pas les autres : le véhicule vivant garde son motif', async () => {
      const trips = [
        ...weekly(1, { tracker: heard(89 * 24 * H), vehicleId: 'mort' }),
        ...weekly(1, { tracker: heard(5 * 60_000), vehicleId: 'vivant' }),
      ];
      const svc = new RecurrenceDetectorService(makePrisma(trips), makeGeocode(), makeStops());
      const res = await svc.detectWithStats('f1');
      expect(res.patterns.map((p) => p.vehicleId)).toEqual(['vivant']);
      expect(res.skippedDormantVehicles).toBe(1);
    });

    /**
     * PIÈGE DE LA TRONCATURE. `take` coupe la liste : en ordre CROISSANT, une flotte qui dépasse
     * le plafond ne recevait que ses trajets les plus VIEUX. La garde de récence jugeant sur la
     * dernière occurrence, toute la flotte serait tombée en « habitude éteinte » d'un seul coup —
     * une extinction totale des propositions sur les gros clients, invisible en dessous du plafond.
     * Ce test verrouille le SENS du tri, pas le plafond.
     */
    it('demande les trajets les PLUS RÉCENTS (la troncature ne doit pas éteindre les motifs)', async () => {
      const prisma = makePrisma(weekly(1, { tracker: heard(5 * 60_000) }));
      await new RecurrenceDetectorService(prisma, makeGeocode(), makeStops()).detectWithStats('f1');
      const args = (prisma as unknown as { trip: { findMany: jest.Mock } }).trip.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual({ startedAt: 'desc' });
      expect(args.take).toBeGreaterThan(0);
    });
  });
});
