import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { VehicleEventsService } from './vehicle-events.service';

function makeUser(over: Record<string, unknown> = {}) {
  return { id: 'u1', role: UserRole.VIEWER, fleetId: 'f1', ...over } as never;
}

function makePrisma(over: Record<string, unknown> = {}) {
  return {
    vehicle: { findUnique: jest.fn(), update: jest.fn() },
    vehicleEvent: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    vehicleGroupAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    trip: { aggregate: jest.fn().mockResolvedValue({ _sum: { distanceKm: 0 } }) },
    ...over,
  } as never;
}

function access(ids: string[] | 'ALL') {
  return { getAccessibleVehicleIds: jest.fn().mockResolvedValue(ids) } as never;
}

describe('VehicleEventsService — scoping tenant (Sprint 7, anti-IDOR)', () => {
  it('assertVehicleAccess : vehicule d\'une AUTRE flotte -> Forbidden', async () => {
    const prisma = makePrisma();
    (prisma as { vehicle: { findUnique: jest.Mock } }).vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'OTHER' });
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await expect(
      svc.assertVehicleAccess(makeUser({ role: UserRole.FLEET_ADMIN }), 'v1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('assertVehicleAccess : vehicule HORS perimetre per-vehicule -> Forbidden', async () => {
    const prisma = makePrisma();
    (prisma as { vehicle: { findUnique: jest.Mock } }).vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'f1' });
    const svc = new VehicleEventsService(prisma, access(['vOTHER'])); // v1 pas dans le perimetre
    await expect(svc.assertVehicleAccess(makeUser(), 'v1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('assertVehicleAccess : vehicule DANS le perimetre -> renvoie le fleetId', async () => {
    const prisma = makePrisma();
    (prisma as { vehicle: { findUnique: jest.Mock } }).vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'f1' });
    const svc = new VehicleEventsService(prisma, access(['v1']));
    await expect(svc.assertVehicleAccess(makeUser(), 'v1')).resolves.toBe('f1');
  });

  it('reportIncident : INCIDENT OPEN dont le fleetId est DERIVE du vehicule (pas du client)', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicle: { findUnique: jest.Mock }; vehicleEvent: { create: jest.Mock } };
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'f1' });
    p.vehicleEvent.create.mockResolvedValue({
      id: 'e1', fleetId: 'f1', vehicleId: 'v1', vehicle: { plate: 'AA-1' }, type: 'INCIDENT', status: 'OPEN',
      severity: 'MEDIUM', title: 'Porte', description: null, startAt: new Date(), endAt: null, allDay: true,
      odometerKm: null, planId: null, linkedEventId: null, resolvedAt: null, metadata: null, source: 'MANUAL',
      createdAt: new Date(), updatedAt: new Date(),
    });
    const svc = new VehicleEventsService(prisma, access('ALL'));
    const dto = await svc.reportIncident(makeUser({ role: UserRole.FLEET_ADMIN }), { vehicleId: 'v1', title: 'Porte' });
    expect(dto.type).toBe('INCIDENT');
    expect(dto.status).toBe('OPEN');
    expect(p.vehicleEvent.create.mock.calls[0][0].data.fleetId).toBe('f1');
  });

  it('create : refuse le type RESERVATION (reserve Sprint 8)', async () => {
    const svc = new VehicleEventsService(makePrisma(), access('ALL'));
    await expect(
      svc.create(makeUser(), { vehicleId: 'v1', type: 'RESERVATION' as never, title: 'x', startAt: new Date().toISOString() }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('list : borne par fleetId + perimetre vehicules (user scope groupe)', async () => {
    const prisma = makePrisma();
    const svc = new VehicleEventsService(prisma, access(['v1', 'v2']));
    await svc.list(makeUser(), { from: new Date('2026-06-01'), to: new Date('2026-06-30') });
    const where = (prisma as { vehicleEvent: { findMany: jest.Mock } }).vehicleEvent.findMany.mock.calls[0][0].where;
    expect(where.fleetId).toBe('f1');
    expect(where.vehicleId).toEqual({ in: ['v1', 'v2'] });
  });
});
