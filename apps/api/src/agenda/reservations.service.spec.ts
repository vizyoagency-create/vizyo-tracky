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
        // Résas fermes -> v3 occupé ; requête immobilisations (blocksVehicle) -> aucune.
        findMany: jest.fn().mockImplementation(({ where }: { where: { blocksVehicle?: boolean } }) =>
          Promise.resolve(where?.blocksVehicle ? [] : [{ vehicleId: 'v3' }]),
        ),
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

  it('suggest : véhicule immobilisé par un incident bloquant -> exclu ET compté', async () => {
    const now = Date.now();
    const start = new Date(now + 24 * 3_600_000); // demain
    const end = new Date(now + 26 * 3_600_000);
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'AA-1', seats: 5, childSeats: 0, features: [] },
          { id: 'v2', plate: 'BB-2', seats: 5, childSeats: 0, features: [] },
        ]),
      },
      vehicleEvent: {
        // Incident OPEN bloquant sans fin sur v2 -> immobilisé jusqu'à résolution.
        findMany: jest.fn().mockImplementation(({ where }: { where: { blocksVehicle?: boolean } }) =>
          Promise.resolve(
            where?.blocksVehicle
              ? [{ vehicleId: 'v2', type: 'INCIDENT', startAt: new Date(now - 3_600_000), endAt: null }]
              : [],
          ),
        ),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    const res = await svc.suggest(makeUser(), { startAt: start.toISOString(), endAt: end.toISOString() });
    expect(res.vehicles.map((v) => v.vehicleId)).toEqual(['v1']);
    expect(res.excludedImmobilized).toBe(1);
  });

  it('suggest : capacité inconnue (places NULL) avec critère -> exclu mais COMPTÉ (pas de silence)', async () => {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v1', plate: 'AA-1', seats: null, childSeats: null, features: [] }, // capacité non renseignée
          { id: 'v2', plate: 'BB-2', seats: 5, childSeats: null, features: [] },
        ]),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    const res = await svc.suggest(makeUser(), { ...SLOT, criteria: { minSeats: 4 } });
    expect(res.vehicles.map((v) => v.vehicleId)).toEqual(['v2']);
    expect(res.excludedUnknownCapacity).toBe(1);
    expect(res.excludedImmobilized).toBe(0);
  });

  it('suggest : un trajet EN COURS (endedAt NULL) ne bloque PLUS un créneau futur', async () => {
    const now = Date.now();
    const start = new Date(now + 24 * 3_600_000);
    const end = new Date(now + 26 * 3_600_000);
    const prisma = makePrisma({
      vehicle: { findMany: jest.fn().mockResolvedValue([{ id: 'v1', plate: 'AA-1', seats: 5, childSeats: 0, features: [] }]) },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    await svc.suggest(makeUser(), { startAt: start.toISOString(), endAt: end.toISOString() });
    // Créneau lointain -> la clause « trajet ouvert » n'est PAS incluse (fin inconnue ≠ infinie).
    const or = (prisma as { trip: { findMany: jest.Mock } }).trip.findMany.mock.calls[0][0].where.OR;
    expect(or).toEqual([{ endedAt: { gt: start } }]);
  });

  it('request : véhicule immobilisé (incident bloquant) -> 409 Conflict', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { blocksVehicle?: boolean } }) =>
          Promise.resolve(
            where?.blocksVehicle
              ? [{ vehicleId: 'v1', type: 'INCIDENT', startAt: new Date('2026-06-30T00:00:00Z'), endAt: null }]
              : [],
          ),
        ),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    await expect(svc.request(makeUser(), { vehicleId: 'v1', ...SLOT })).rejects.toBeInstanceOf(ConflictException);
  });

  it('request : maintenance bloquante SANS fin d\'il y a 3 jours -> ne bloque plus (fenêtre = sa journée)', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { blocksVehicle?: boolean } }) =>
          Promise.resolve(
            where?.blocksVehicle
              ? [{ vehicleId: 'v1', type: 'MAINTENANCE', startAt: new Date('2026-06-28T00:00:00Z'), endAt: null }]
              : [],
          ),
        ),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue(evRow()),
        update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    const dto = await svc.request(makeUser(), { vehicleId: 'v1', ...SLOT });
    expect(dto.status).toBe('REQUESTED');
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

  it('confirm : refuse une réservation NON en attente (déjà CONFIRMED) -> BadRequest', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow({ status: 'CONFIRMED' })),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    await expect(svc.confirm(makeUser(), 'r1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('confirm : véhicule qui roule déjà sur le créneau (trajet réel) -> 409 Conflict', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow()),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
      },
      trip: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ id: 't1' }) },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    await expect(svc.confirm(makeUser(), 'r1', {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('cancel : refuse une réservation TERMINÉE (DONE) -> BadRequest', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow({ status: 'DONE' })),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        create: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    await expect(svc.cancel(makeUser(), 'r1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('confirm : violation de la contrainte EXCLUDE -> traduite en 409 (course concurrente)', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow()),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockRejectedValue(
          new Error('conflicting key value violates exclusion constraint "no_overlap_reservation"'),
        ),
        create: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents());
    await expect(svc.confirm(makeUser(), 'r1', {})).rejects.toBeInstanceOf(ConflictException);
  });
});
