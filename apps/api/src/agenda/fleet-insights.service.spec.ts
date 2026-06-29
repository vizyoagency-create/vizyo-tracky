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
