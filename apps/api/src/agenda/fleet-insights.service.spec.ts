import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { FleetInsightsService } from './fleet-insights.service';

function makeUser(over: Record<string, unknown> = {}) {
  return { id: 'u1', role: UserRole.VIEWER, fleetId: 'f1', ...over } as never;
}

function makePrisma(over: Record<string, unknown> = {}) {
  return {
    trip: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { findMany: jest.fn().mockResolvedValue([]) },
    vehicleGroupAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    ...over,
  } as never;
}

function access(ids: string[] | 'ALL') {
  return { getAccessibleVehicleIds: jest.fn().mockResolvedValue(ids) } as never;
}

const FROM = new Date('2026-06-01T00:00:00Z');
const TO = new Date('2026-06-30T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('FleetInsightsService — Sprint 8 Palier A (visibilité, anti-IDOR)', () => {
  it('getAvailability : borne par fleetId + périmètre véhicules ; mappe trajet -> créneau', async () => {
    const prisma = makePrisma({
      trip: {
        findMany: jest.fn().mockResolvedValue([
          {
            vehicleId: 'v1',
            startedAt: new Date('2026-06-10T08:00:00Z'),
            endedAt: new Date('2026-06-10T09:00:00Z'),
            distanceKm: 12.34,
            vehicle: { plate: 'AA-1' },
          },
        ]),
      },
    });
    const svc = new FleetInsightsService(prisma, access(['v1', 'v2']));
    const res = await svc.getAvailability(makeUser(), FROM, TO);

    const where = (prisma as { trip: { findMany: jest.Mock } }).trip.findMany.mock.calls[0][0].where;
    expect(where.fleetId).toBe('f1');
    expect(where.vehicleId).toEqual({ in: ['v1', 'v2'] });
    expect(res.slots).toHaveLength(1);
    expect(res.slots[0].vehiclePlate).toBe('AA-1');
    expect(res.slots[0].ongoing).toBe(false);
    expect(res.slots[0].distanceKm).toBe(12.3);
  });

  it('getAvailability : trajet en cours (endedAt null) -> ongoing=true, endAt=null ; super-admin sans filtre flotte', async () => {
    const prisma = makePrisma({
      trip: {
        findMany: jest.fn().mockResolvedValue([
          { vehicleId: 'v1', startedAt: new Date('2026-06-10T08:00:00Z'), endedAt: null, distanceKm: 5, vehicle: { plate: 'BB-2' } },
        ]),
      },
    });
    const svc = new FleetInsightsService(prisma, access('ALL'));
    const res = await svc.getAvailability(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), FROM, TO);

    expect(res.slots[0].ongoing).toBe(true);
    expect(res.slots[0].endAt).toBeNull();
    const where = (prisma as { trip: { findMany: jest.Mock } }).trip.findMany.mock.calls[0][0].where;
    expect(where.fleetId).toBeUndefined(); // super-admin : pas de borne flotte
    expect(where.vehicleId).toBeUndefined(); // accès ALL : pas de borne véhicule
  });

  it('getUtilization : inclut les véhicules SANS trajet (0 % = priorité mutualisation) + 28 cellules', async () => {
    const prisma = makePrisma({
      vehicle: { findMany: jest.fn().mockResolvedValue([{ id: 'v1', plate: 'AA-1' }, { id: 'v2', plate: 'BB-2' }]) },
      trip: {
        findMany: jest.fn().mockResolvedValue([
          { vehicleId: 'v1', startedAt: new Date('2026-06-10T08:00:00Z'), endedAt: new Date('2026-06-10T09:00:00Z'), distanceKm: 10, vehicle: { plate: 'AA-1' } },
        ]),
      },
    });
    const svc = new FleetInsightsService(prisma, access('ALL'));
    const res = await svc.getUtilization(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), FROM, TO);

    expect(res.vehicles).toHaveLength(2);
    const v2 = res.vehicles.find((v) => v.vehicleId === 'v2')!;
    expect(v2.tripCount).toBe(0);
    expect(v2.underutilized).toBe(true);
    const v1 = res.vehicles.find((v) => v.vehicleId === 'v1')!;
    expect(v1.tripCount).toBe(1);
    expect(v1.cells).toHaveLength(28); // 7 jours × 4 créneaux
  });

  it('getUtilization : scoping appliqué AUX DEUX requêtes (véhicules ET trajets)', async () => {
    const prisma = makePrisma();
    const svc = new FleetInsightsService(prisma, access(['v1']));
    await svc.getUtilization(makeUser(), FROM, TO);

    const vehWhere = (prisma as { vehicle: { findMany: jest.Mock } }).vehicle.findMany.mock.calls[0][0].where;
    expect(vehWhere.fleetId).toBe('f1');
    expect(vehWhere.id).toEqual({ in: ['v1'] });
    const tripWhere = (prisma as { trip: { findMany: jest.Mock } }).trip.findMany.mock.calls[0][0].where;
    expect(tripWhere.fleetId).toBe('f1');
    expect(tripWhere.vehicleId).toEqual({ in: ['v1'] });
  });

  it('getAvailability : véhicule demandé HORS périmètre -> Forbidden (anti-IDOR)', async () => {
    const svc = new FleetInsightsService(makePrisma(), access(['v1']));
    await expect(
      svc.getAvailability(makeUser(), FROM, TO, { vehicleId: 'v2' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ─── Dormance : « injoignable » n'est pas « sous-utilisé » ──────────────────────────────────

  it('getUtilization : véhicule DORMANT (89 j) -> requalifié (plus « sous-utilisé »), compté, poussé en fin de liste', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          // Dormant : 0 % d'utilisation, donc premier du tri historique -> volait la tête de liste.
          { id: 'v-dormant', plate: 'FV-941-LZ', tracker: { id: 't1', lastSeenAt: new Date(Date.now() - 89 * DAY_MS) } },
          // Vrai candidat à la mutualisation : il roule un peu, son boîtier parle.
          { id: 'v-live', plate: 'AA-1', tracker: { id: 't2', lastSeenAt: new Date() } },
        ]),
      },
      trip: {
        findMany: jest.fn().mockResolvedValue([
          { vehicleId: 'v-live', startedAt: new Date('2026-06-10T08:00:00Z'), endedAt: new Date('2026-06-10T09:00:00Z'), distanceKm: 10, vehicle: { plate: 'AA-1' } },
        ]),
      },
    });
    const svc = new FleetInsightsService(prisma, access('ALL'));
    const res = await svc.getUtilization(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), FROM, TO);

    const dormant = res.vehicles.find((v) => v.vehicleId === 'v-dormant')!;
    expect(dormant.dormant).toBe(true);
    expect(dormant.underutilized).toBe(false); // conseil d'exploitation faux -> retiré
    expect(dormant.silenceLabel).toBe('89 j');
    // Non destructif : le véhicule reste dans la réponse, avec son vrai ratio.
    expect(res.vehicles).toHaveLength(2);
    expect(res.vehicles[res.vehicles.length - 1].vehicleId).toBe('v-dormant'); // relégué en fin de liste
    // Le chiffre ne baisse pas en silence.
    expect(res.dormantCount).toBe(1);
    // Le véhicule vivant garde son étiquette de mutualisation.
    expect(res.vehicles.find((v) => v.vehicleId === 'v-live')!.underutilized).toBe(true);
  });

  it('getUtilization : silence de 2 h -> véhicule NORMAL (un stationnement de nuit reste sous-utilisé)', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'AA-1', tracker: { id: 't1', lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
        ]),
      },
    });
    const svc = new FleetInsightsService(prisma, access('ALL'));
    const res = await svc.getUtilization(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), FROM, TO);

    expect(res.vehicles[0].dormant).toBe(false);
    expect(res.vehicles[0].underutilized).toBe(true);
    expect(res.dormantCount).toBe(0);
  });

  it('getUtilization : véhicule SANS boîtier (ou boîtier jamais vu) -> jamais dormant', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v-nu', plate: 'TEST-001-XX', tracker: null },
          { id: 'v-jamais', plate: 'TEST-002-XX', tracker: { id: 't9', lastSeenAt: null } },
        ]),
      },
    });
    const svc = new FleetInsightsService(prisma, access('ALL'));
    const res = await svc.getUtilization(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), FROM, TO);

    expect(res.vehicles.every((v) => v.dormant === false)).toBe(true);
    expect(res.vehicles.every((v) => v.underutilized === true)).toBe(true);
    expect(res.dormantCount).toBe(0);
  });

  it('getUtilization : réintégration automatique dès que le boîtier ré-émet (aucun drapeau à lever)', async () => {
    const veh = (lastSeenAt: Date) =>
      makePrisma({
        vehicle: { findMany: jest.fn().mockResolvedValue([{ id: 'v1', plate: 'AA-1', tracker: { id: 't1', lastSeenAt } }]) },
      });
    const svcMuet = new FleetInsightsService(veh(new Date(Date.now() - 52 * DAY_MS)), access('ALL'));
    const muet = await svcMuet.getUtilization(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), FROM, TO);
    expect(muet.vehicles[0].dormant).toBe(true);

    const svcRevenu = new FleetInsightsService(veh(new Date()), access('ALL'));
    const revenu = await svcRevenu.getUtilization(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), FROM, TO);
    expect(revenu.vehicles[0].dormant).toBe(false);
    expect(revenu.vehicles[0].underutilized).toBe(true); // redevient un candidat normal
    expect(revenu.dormantCount).toBe(0);
  });

  it('getUtilization : véhicule devenu muet EN COURS de fenêtre -> plus de créneaux « libres » proposés, heatmap intacte', async () => {
    // Il a roulé (donc hasActivity=true) puis s'est tu : sans garde, on proposerait
    // « Mercredi matin libre » sur un véhicule qu'on ne sait plus joindre.
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'FL-787-KV', tracker: { id: 't1', lastSeenAt: new Date(Date.now() - 52 * DAY_MS) } },
        ]),
      },
      trip: {
        findMany: jest.fn().mockResolvedValue([
          { vehicleId: 'v1', startedAt: new Date('2026-06-10T08:00:00Z'), endedAt: new Date('2026-06-10T09:00:00Z'), distanceKm: 10, vehicle: { plate: 'FL-787-KV' } },
        ]),
      },
    });
    const svc = new FleetInsightsService(prisma, access('ALL'));
    const res = await svc.getUtilization(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), FROM, TO);

    expect(res.vehicles[0].freePatterns).toEqual([]);
    expect(res.vehicles[0].tripCount).toBe(1); // l'historique n'est pas touché
    expect(res.vehicles[0].cells).toHaveLength(28);
  });

  it('getAvailability : filtre groupe VIDE -> aucune donnée, aucune requête trajets', async () => {
    const prisma = makePrisma();
    const svc = new FleetInsightsService(prisma, access('ALL'));
    const res = await svc.getAvailability(
      makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }),
      FROM,
      TO,
      { groupId: 'g1' },
    );
    expect(res.slots).toEqual([]);
    expect((prisma as { trip: { findMany: jest.Mock } }).trip.findMany).not.toHaveBeenCalled();
  });
});
