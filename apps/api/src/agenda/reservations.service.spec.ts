import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ReservationsService } from './reservations.service';

function makeUser(over: Record<string, unknown> = {}) {
  return { id: 'u1', role: UserRole.FLEET_ADMIN, fleetId: 'f1', ...over } as never;
}

function makePrisma(over: Record<string, unknown> = {}) {
  return {
    vehicleEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    vehicle: { findMany: jest.fn().mockResolvedValue([]) },
    trip: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    ...over,
  } as never;
}

function access(ids: string[] | 'ALL') {
  return { getAccessibleVehicleIds: jest.fn().mockResolvedValue(ids) } as never;
}

function makeEvents(over: Record<string, unknown> = {}) {
  return {
    assertVehicleAccess: jest.fn().mockResolvedValue('f1'),
    list: jest.fn().mockResolvedValue([]),
    ...over,
  } as never;
}

function evRow(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    fleetId: 'f1',
    vehicleId: 'v1',
    vehicle: { plate: 'AA-1' },
    type: 'RESERVATION',
    category: null,
    status: 'REQUESTED',
    severity: null,
    title: 'Réservation',
    description: null,
    startAt: new Date('2026-07-01T09:00:00Z'),
    endAt: new Date('2026-07-01T12:00:00Z'),
    allDay: false,
    odometerKm: null,
    planId: null,
    linkedEventId: null,
    resolvedAt: null,
    metadata: null,
    source: 'MANUAL',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const SLOT = { startAt: '2026-07-01T09:00:00Z', endAt: '2026-07-01T12:00:00Z' };

describe('ReservationsService — Sprint 8 Palier B', () => {
  it('request : crée une réservation REQUESTED, fleetId DÉRIVÉ du véhicule, demandeur en metadata', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicleEvent: { create: jest.Mock } };
    p.vehicleEvent.create.mockResolvedValue(evRow({ status: 'REQUESTED', metadata: { requesterId: 'u1' } }));
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());

    const dto = await svc.request(makeUser(), { vehicleId: 'v1', ...SLOT });
    expect(dto.status).toBe('REQUESTED');
    expect(dto.type).toBe('RESERVATION');
    const data = p.vehicleEvent.create.mock.calls[0][0].data;
    expect(data.status).toBe('REQUESTED');
    expect(data.fleetId).toBe('f1');
    expect(data.allDay).toBe(false);
    expect(data.metadata.requesterId).toBe('u1');
  });

  it('request : créneau déjà réservé (CONFIRMED chevauchant) -> 409 Conflict', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findMany: jest.fn().mockResolvedValue([{ id: 'x', vehicle: { plate: 'AA-1' } }]),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    await expect(svc.request(makeUser(), { vehicleId: 'v1', ...SLOT })).rejects.toBeInstanceOf(ConflictException);
  });

  it('request : véhicule qui ROULE déjà sur le créneau (trajet réel) -> 409 Conflict', async () => {
    const prisma = makePrisma({
      trip: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ id: 't1' }) },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    await expect(svc.request(makeUser(), { vehicleId: 'v1', ...SLOT })).rejects.toBeInstanceOf(ConflictException);
  });

  it('suggest : équipements insensibles à la casse + exclut les véhicules occupés', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'AA-1', seats: 5, childSeats: 2, features: ['GPS', 'Clim'] },
          { id: 'v2', plate: 'BB-2', seats: 5, childSeats: 0, features: ['GPS'] }, // pas de Clim
          { id: 'v3', plate: 'CC-3', seats: 9, childSeats: 3, features: ['GPS', 'Clim'] }, // occupé
        ]),
      },
      vehicleEvent: {
        findMany: jest.fn().mockResolvedValue([{ vehicleId: 'v3' }]), // v3 a une réservation ferme
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    const res = await svc.suggest(makeUser(), { ...SLOT, criteria: { requiredFeatures: ['clim'] } });
    expect(res.vehicles.map((v) => v.vehicleId)).toEqual(['v1']); // v2 sans Clim, v3 occupé
    expect(res.vehicles[0].underutilized).toBe(true);
  });

  it('confirm : réservation hors périmètre véhicule -> Forbidden (anti-IDOR)', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow({ vehicleId: 'v2' })),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access(['v1']), makeEvents()); // v2 hors périmètre
    await expect(svc.confirm(makeUser({ role: UserRole.VIEWER }), 'r1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('confirm : conflit ferme détecté au pré-check -> 409 Conflict', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow()),
        findMany: jest.fn().mockResolvedValue([{ id: 'other', vehicle: { plate: 'AA-1' } }]),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    await expect(svc.confirm(makeUser(), 'r1', {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('confirm : sans conflit -> CONFIRMED (bloquant)', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow()),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(evRow({ status: 'CONFIRMED' })),
        create: jest.fn(),
      },
    });
    const p = prisma as { vehicleEvent: { update: jest.Mock } };
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    const dto = await svc.confirm(makeUser(), 'r1', {});
    expect(dto.status).toBe('CONFIRMED');
    expect(p.vehicleEvent.update.mock.calls[0][0].data.status).toBe('CONFIRMED');
  });

  it('cancel : passe la réservation en CANCELLED', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow({ status: 'CONFIRMED' })),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(evRow({ status: 'CANCELLED' })),
        create: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    const dto = await svc.cancel(makeUser(), 'r1');
    expect(dto.status).toBe('CANCELLED');
  });
});
