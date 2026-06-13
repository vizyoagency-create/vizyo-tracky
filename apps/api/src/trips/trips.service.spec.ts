/**
 * Tests unitaires du pipeline live de TripsService.
 *
 * Objectif : verrouiller les invariants critiques pour la fiabilite des
 * rapports apres le Sprint corruption-durations :
 *   1. `durationSeconds >= 0` ALWAYS dans la base.
 *   2. `endedAt >= startedAt` ALWAYS.
 *   3. `distanceMeters >= 0`, `distanceKm >= 0`.
 *   4. `maxSpeed`, `avgSpeed` clampes dans [0, 250] km/h.
 *   5. Les retransmissions tardives (timestamp out-of-order) sont ignorees,
 *      n'ecrasent pas `state.lastTimestamp` et ne corrompent pas la finale.
 *   6. Le clamp defensif de `finalizeTrip` rattrape un `endTime < startedAt`
 *      hypothetique (si appele directement, hors flux normal).
 *   7. `dailySummary` ignore les valeurs negatives heritees (defense en
 *      profondeur pour les bases pas encore migrees).
 */
import { Prisma } from '@prisma/client';
import { TripsService } from './trips.service';
import { TripSegmenterService } from './trip-segmenter.service';

type AnyObj = Record<string, unknown>;

class FakePrisma {
  trips = new Map<string, AnyObj>();
  vehicles = new Map<string, AnyObj>();
  positions: AnyObj[] = [];
  private seq = 0;

  trip = {
    create: async ({ data }: { data: AnyObj }) => {
      const id = `trip-${++this.seq}`;
      const row = { id, ...data };
      this.trips.set(id, row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: AnyObj }) => {
      const cur = this.trips.get(where.id);
      if (!cur) throw new Error(`trip ${where.id} not found`);
      const next = { ...cur, ...data };
      this.trips.set(where.id, next);
      return next;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const cur = this.trips.get(where.id);
      this.trips.delete(where.id);
      return cur;
    },
    deleteMany: async () => ({ count: 0 }),
    findMany: async () => [],
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.trips.get(where.id) ?? null,
  };

  vehicle = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.vehicles.get(where.id) ?? null,
  };

  position = {
    findMany: async () => this.positions,
  };
}

class FakeGateway {
  startedEvents: AnyObj[] = [];
  completedEvents: AnyObj[] = [];
  emitTripStarted(_fleetId: string, ev: AnyObj) {
    this.startedEvents.push(ev);
  }
  emitTripCompleted(_fleetId: string, ev: AnyObj) {
    this.completedEvents.push(ev);
  }
}

class FakeMapMatching {
  // Synchrone par defaut : ne renvoie rien, evite les writes async pendants.
  async match(_pts: Array<{ lat: number; lng: number }>) {
    return null;
  }
}

const FLEET_ID = 'fleet-1';
const VEHICLE_ID = 'veh-1';
const TRACKER_ID = 'trk-1';

function buildService() {
  const prisma = new FakePrisma();
  prisma.vehicles.set(VEHICLE_ID, { id: VEHICLE_ID, currentDriverId: null });
  const gateway = new FakeGateway();
  const segmenter = new TripSegmenterService();
  const mapMatching = new FakeMapMatching();
  const svc = new TripsService(
    prisma as any,
    gateway as any,
    segmenter,
    mapMatching as any,
  );
  // onModuleInit charge les trips ouverts depuis la DB ; ici aucun.
  // On force `ready = true` directement.
  (svc as any).ready = true;
  return { svc, prisma, gateway };
}

function pos(opts: {
  minute: number;
  second?: number;
  speedKmh: number;
  lat?: number;
  lng?: number;
  ignition?: boolean;
}) {
  return {
    trackerId: TRACKER_ID,
    vehicleId: VEHICLE_ID,
    fleetId: FLEET_ID,
    lat: opts.lat ?? 33.57 + opts.minute * 0.001,
    lng: opts.lng ?? -7.59,
    speedKmh: opts.speedKmh,
    timestamp: new Date(Date.UTC(2026, 0, 1, 10, opts.minute, opts.second ?? 0)),
    ignition: opts.ignition ?? true,
  };
}

describe('TripsService — invariants rapports', () => {
  describe('processPosition + finalizeTrip', () => {
    it('produces a trip with non-negative duration in nominal flow', async () => {
      const { svc, prisma } = buildService();

      // Demarre un trip : speed > 5 pendant >= 30s puis poursuit puis arret 5min.
      await svc.processPosition(pos({ minute: 0, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 0, second: 30, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 1, speedKmh: 50 }));
      await svc.processPosition(pos({ minute: 2, speedKmh: 60 }));
      await svc.processPosition(pos({ minute: 3, speedKmh: 40 }));
      await svc.processPosition(pos({ minute: 4, speedKmh: 0 }));
      // 5 min d'arret = TRIP_STOP_TIMEOUT_MS → finalize 'speed'
      await svc.processPosition(pos({ minute: 9, speedKmh: 0 }));

      const trips = Array.from(prisma.trips.values());
      expect(trips.length).toBe(1);
      const t = trips[0]! as AnyObj;
      expect(t.endedAt).toBeDefined();
      expect((t.durationSeconds as number)).toBeGreaterThanOrEqual(0);
      expect((t.distanceMeters as number)).toBeGreaterThanOrEqual(0);
      expect((t.distanceKm as number)).toBeGreaterThanOrEqual(0);
      expect((t.maxSpeed as number)).toBeGreaterThanOrEqual(0);
      expect((t.maxSpeed as number)).toBeLessThanOrEqual(250);
      expect((t.avgSpeed as number)).toBeGreaterThanOrEqual(0);
      expect((t.avgSpeed as number)).toBeLessThanOrEqual(250);
      expect((t.endedAt as Date).getTime())
        .toBeGreaterThanOrEqual((t.startedAt as Date).getTime());
    });

    it('IGNORES out-of-order positions (retransmission scenario)', async () => {
      // C'est LE test du bug prod tracker 7ae3d894. Si Fix A regresse, ce
      // test casse immediatement.
      const { svc, prisma } = buildService();

      // Phase 1 : flux live monotone qui demarre + remplit le trip.
      await svc.processPosition(pos({ minute: 0, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 0, second: 30, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 1, speedKmh: 40 }));
      await svc.processPosition(pos({ minute: 2, speedKmh: 50 }));
      await svc.processPosition(pos({ minute: 3, speedKmh: 60 }));
      await svc.processPosition(pos({ minute: 4, speedKmh: 30 }));

      // Capture state avant retransmissions
      const stateBefore = (svc as any).openTrips.get(TRACKER_ID);
      expect(stateBefore).toBeDefined();
      const lastTsBefore = stateBefore.lastTimestamp.getTime();
      const distBefore = stateBefore.dist;

      // Phase 2 : burst de retransmissions tardives (timestamps -25 min).
      // Le tracker en mode store-and-forward renvoie 5 positions vieilles.
      for (let m = 0; m < 5; m++) {
        await svc.processPosition({
          ...pos({ minute: m, speedKmh: 25, lat: 33.50 + m * 0.001 }),
          // Force timestamp anterieur au state.lastTimestamp
          timestamp: new Date(Date.UTC(2026, 0, 1, 9, 35 + m, 0)),
        });
      }

      const stateAfter = (svc as any).openTrips.get(TRACKER_ID);
      // Invariant majeur : state inchange par les retransmissions.
      expect(stateAfter.lastTimestamp.getTime()).toBe(lastTsBefore);
      expect(stateAfter.dist).toBe(distBefore);

      // Phase 3 : reprise live + arret pour fermer.
      await svc.processPosition(pos({ minute: 5, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 6, speedKmh: 0 }));
      await svc.processPosition(pos({ minute: 11, speedKmh: 0 }));

      const trips = Array.from(prisma.trips.values());
      expect(trips.length).toBe(1);
      const t = trips[0]! as AnyObj;
      // L'invariant cle : aucune duration negative ne doit etre persistee.
      expect((t.durationSeconds as number)).toBeGreaterThanOrEqual(0);
      expect((t.endedAt as Date).getTime())
        .toBeGreaterThanOrEqual((t.startedAt as Date).getTime());
    });

    it('clamps maxSpeed to 250 km/h even if GPS reports glitch values', async () => {
      const { svc, prisma } = buildService();

      await svc.processPosition(pos({ minute: 0, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 0, second: 30, speedKmh: 30 }));
      // Glitch : 9999 km/h (firmware bug). On veut clamp a 250.
      await svc.processPosition(pos({ minute: 1, speedKmh: 9999 }));
      await svc.processPosition(pos({ minute: 2, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 3, speedKmh: 0 }));
      await svc.processPosition(pos({ minute: 8, speedKmh: 0 }));

      const trips = Array.from(prisma.trips.values());
      expect(trips.length).toBe(1);
      expect((trips[0]!.maxSpeed as number)).toBeLessThanOrEqual(250);
    });

    it('clamps negative speedKmh to 0 (defense in depth)', async () => {
      const { svc, prisma } = buildService();

      await svc.processPosition(pos({ minute: 0, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 0, second: 30, speedKmh: 30 }));
      // Glitch : -10 km/h. Doit etre traite comme 0 (n'augmente pas maxSpeed).
      await svc.processPosition(pos({ minute: 1, speedKmh: -10 }));
      await svc.processPosition(pos({ minute: 2, speedKmh: 40 }));
      await svc.processPosition(pos({ minute: 3, speedKmh: 0 }));
      await svc.processPosition(pos({ minute: 8, speedKmh: 0 }));

      const trips = Array.from(prisma.trips.values());
      expect(trips.length).toBe(1);
      expect((trips[0]!.maxSpeed as number)).toBeGreaterThanOrEqual(0);
      expect((trips[0]!.avgSpeed as number)).toBeGreaterThanOrEqual(0);
    });

    it('finalizeTrip clamps endedAt and durationSeconds when called with reversed time', async () => {
      // Acces direct a finalizeTrip (private) pour simuler un caller buggy.
      // Garantit que meme un appel hostile produit des donnees saines.
      const { svc, prisma } = buildService();

      await svc.processPosition(pos({ minute: 0, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 0, second: 30, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 1, speedKmh: 50 }));
      await svc.processPosition(pos({ minute: 2, speedKmh: 50 }));
      await svc.processPosition(pos({ minute: 3, speedKmh: 50 }));

      const state = (svc as any).openTrips.get(TRACKER_ID);
      expect(state).toBeDefined();

      // Force un endTime anterieur au start (cas pathologique).
      const reversedEnd = new Date(state.startedAt.getTime() - 60_000);
      await (svc as any).finalizeTrip(state, reversedEnd, 'manual-test');

      const trips = Array.from(prisma.trips.values());
      expect(trips.length).toBe(1);
      const t = trips[0]! as AnyObj;
      expect((t.durationSeconds as number)).toBeGreaterThanOrEqual(0);
      expect((t.endedAt as Date).getTime())
        .toBeGreaterThanOrEqual((t.startedAt as Date).getTime());
    });

    it('drops trip with distance < TRIP_MIN_DISTANCE_METERS without persisting', async () => {
      const { svc, prisma } = buildService();
      // Bouge tres peu (1m) puis arret. Distance < 50m → trip drop.
      await svc.processPosition(pos({ minute: 0, speedKmh: 10, lat: 33.57000 }));
      await svc.processPosition(pos({ minute: 0, second: 30, speedKmh: 10, lat: 33.57001 }));
      await svc.processPosition(pos({ minute: 1, speedKmh: 0, lat: 33.57001 }));
      await svc.processPosition(pos({ minute: 6, speedKmh: 0, lat: 33.57001 }));

      // Trip cree puis supprime → 0 trip persiste.
      expect(prisma.trips.size).toBe(0);
    });

    it('finalizeTrip est idempotent : un 2e appel sur un state deja cloture ne re-update pas (anti-race)', async () => {
      // Reproduit la course prod : un burst store-and-forward (ou checkTimeouts)
      // ré-entrait finalizeTrip sur le MÊME state -> double clôture / P2025.
      const { svc, prisma, gateway } = buildService();
      await svc.processPosition(pos({ minute: 0, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 0, second: 30, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 1, speedKmh: 50 }));
      await svc.processPosition(pos({ minute: 2, speedKmh: 50 }));

      const state = (svc as any).openTrips.get(TRACKER_ID);
      expect(state).toBeDefined();

      // 1er finalize → clôture + retire de openTrips + 1 event.
      await (svc as any).finalizeTrip(state, new Date(Date.UTC(2026, 0, 1, 10, 3)), 'speed');
      expect((svc as any).openTrips.get(TRACKER_ID)).toBeUndefined();
      expect(gateway.completedEvents.length).toBe(1);
      expect(prisma.trips.size).toBe(1);

      // 2e finalize sur le MÊME state (stale) → no-op grâce au claim.
      await (svc as any).finalizeTrip(state, new Date(Date.UTC(2026, 0, 1, 10, 3)), 'timeout');
      expect(gateway.completedEvents.length).toBe(1); // pas de double event
      expect(prisma.trips.size).toBe(1);
    });

    it('finalizeTrip avale un P2025 (trip supprime entre-temps) sans throw', async () => {
      const { svc, prisma } = buildService();
      await svc.processPosition(pos({ minute: 0, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 0, second: 30, speedKmh: 30 }));
      await svc.processPosition(pos({ minute: 1, speedKmh: 50 }));
      await svc.processPosition(pos({ minute: 2, speedKmh: 50 }));

      const state = (svc as any).openTrips.get(TRACKER_ID);
      // Simule une suppression concurrente : l'update jette P2025.
      (prisma as any).trip.update = async () => {
        throw new Prisma.PrismaClientKnownRequestError('No record found for update', {
          code: 'P2025',
          clientVersion: 'test',
        });
      };

      await expect(
        (svc as any).finalizeTrip(state, new Date(Date.UTC(2026, 0, 1, 10, 3)), 'speed'),
      ).resolves.toBeUndefined();
    });
  });

  describe('dailySummary clamping (defense for legacy rows)', () => {
    it('ignores negative durationSeconds and distanceMeters in aggregation', async () => {
      const { svc, prisma } = buildService();

      // Insere 3 lignes legacy directement dans le fake Prisma.
      const day = new Date('2026-04-25T00:00:00.000Z');
      (prisma.trip as any).findMany = async () => [
        // Legacy negatif
        { id: 'a', startedAt: day, endedAt: new Date(day.getTime() + 1000),
          durationSeconds: -600, distanceMeters: -1500, maxSpeed: -50,
          fleetId: FLEET_ID, vehicleId: VEHICLE_ID },
        // Sain
        { id: 'b', startedAt: day, endedAt: new Date(day.getTime() + 1000),
          durationSeconds: 600, distanceMeters: 5000, maxSpeed: 80,
          fleetId: FLEET_ID, vehicleId: VEHICLE_ID },
        // Glitch firmware (vitesse aberrante)
        { id: 'c', startedAt: day, endedAt: new Date(day.getTime() + 1000),
          durationSeconds: 300, distanceMeters: 2000, maxSpeed: 9999,
          fleetId: FLEET_ID, vehicleId: VEHICLE_ID },
      ];

      const result = await svc.dailySummary(
        { userId: 'u', role: 'SUPER_ADMIN' as any, fleetId: FLEET_ID },
        {},
      );
      expect(result.length).toBe(1);
      const day0 = result[0]!;
      // Negatives ignorees : (-600) traite comme 0, donc total = 0 + 600 + 300
      expect(day0.totalDurationSeconds).toBe(900);
      // (-1500) ignore : total = 0 + 5000 + 2000
      expect(day0.totalDistanceMeters).toBe(7000);
      // 9999 clampe a 250 ; max(0, 80, 250) = 250
      expect(day0.maxSpeed).toBeLessThanOrEqual(250);
      expect(day0.maxSpeed).toBe(250);
    });
  });
});
