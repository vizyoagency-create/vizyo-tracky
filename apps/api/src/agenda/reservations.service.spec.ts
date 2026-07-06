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

/** Résolveur de permissions mocké. `canManage` pilote le direct-confirm (#5). */
function makePerms(canManage = false) {
  return {
    canOnVehicle: jest.fn().mockResolvedValue(canManage),
    canGlobally: jest.fn().mockResolvedValue(canManage),
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
    await expect(svc.request(makeUser(), { vehicleId: 'v1', ...SLOT })).rejects.toBeInstanceOf(ConflictException);
  });

  it('request : véhicule qui ROULE déjà sur le créneau (trajet réel) -> 409 Conflict', async () => {
    const prisma = makePrisma({
      trip: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ id: 't1' }) },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
    const res = await svc.suggest(makeUser(), { ...SLOT, criteria: { requiredFeatures: ['clim'] } });
    expect(res.vehicles.map((v) => v.vehicleId)).toEqual(['v1']); // v2 sans Clim, v3 occupé
    expect(res.vehicles[0].underutilized).toBe(true);
  });

  it('suggest : super-admin avec fleetId -> scope le parc à CETTE société (where.fleetId)', async () => {
    const prisma = makePrisma({ vehicle: { findMany: jest.fn().mockResolvedValue([]) } });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
    await svc.suggest(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null }), { ...SLOT, fleetId: 'f9' });
    const where = (prisma as { vehicle: { findMany: jest.Mock } }).vehicle.findMany.mock.calls[0][0].where;
    expect(where.fleetId).toBe('f9'); // plus d'agrégation multi-flottes pour un super-admin
  });

  it('suggest : non-super-admin ne peut pas viser une autre société (fleetId ≠ la sienne) -> 403', async () => {
    const svc = new ReservationsService(makePrisma(), access('ALL'), makeEvents(), makePerms());
    await expect(
      svc.suggest(makeUser({ fleetId: 'f1' }), { ...SLOT, fleetId: 'fOTHER' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
    const res = await svc.suggest(makeUser(), { ...SLOT, criteria: { minSeats: 4 } });
    expect(res.vehicles.map((v) => v.vehicleId)).toEqual(['v2']);
    expect(res.excludedUnknownCapacity).toBe(1);
    expect(res.excludedImmobilized).toBe(0);
  });

  it('suggest : un trajet EN COURS (endedAt NULL) est borné par une fenêtre d\'occupation (≤ 8h) — pas de blocage lointain', async () => {
    const now = Date.now();
    const start = new Date(now + 24 * 3_600_000); // créneau dans 24h
    const end = new Date(now + 26 * 3_600_000);
    const prisma = makePrisma({
      vehicle: { findMany: jest.fn().mockResolvedValue([{ id: 'v1', plate: 'AA-1', seats: 5, childSeats: 0, features: [] }]) },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
    await svc.suggest(makeUser(), { startAt: start.toISOString(), endAt: end.toISOString() });
    const or = (prisma as { trip: { findMany: jest.Mock } }).trip.findMany.mock.calls[0][0].where.OR;
    // Trajet clos : endedAt > start. Trajet ouvert : borné à (start − 8h) — un trajet démarré
    // MAINTENANT ne bloque pas ce créneau lointain (bug B4 corrigé) mais bloquerait un créneau proche.
    expect(or).toHaveLength(2);
    expect(or[0]).toEqual({ endedAt: { gt: start } });
    expect(or[1].endedAt).toBeNull();
    expect(or[1].startedAt.gt.getTime()).toBe(start.getTime() - 8 * 3_600_000);
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
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
    const svc = new ReservationsService(prisma, access(['v1']), makeEvents(), makePerms()); // v2 hors périmètre
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());
    await expect(svc.confirm(makeUser(), 'r1', {})).rejects.toBeInstanceOf(ConflictException);
  });

  // ─── #5 — droit de gérer -> placement DIRECT / sinon -> file de demandes ───
  it('request : appelant qui peut GÉRER -> réservation CONFIRMED directe (pas de demande)', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicleEvent: { create: jest.Mock } };
    p.vehicleEvent.create.mockResolvedValue(evRow({ status: 'CONFIRMED' }));
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));

    const dto = await svc.request(makeUser(), { vehicleId: 'v1', ...SLOT });
    expect(dto.status).toBe('CONFIRMED');
    expect(p.vehicleEvent.create.mock.calls[0][0].data.status).toBe('CONFIRMED');
  });

  it('request : appelant SANS droit de gérer -> REQUESTED (file de demandes)', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicleEvent: { create: jest.Mock } };
    p.vehicleEvent.create.mockResolvedValue(evRow({ status: 'REQUESTED' }));
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(false));

    const dto = await svc.request(makeUser(), { vehicleId: 'v1', ...SLOT });
    expect(dto.status).toBe('REQUESTED');
  });

  // ─── #4 — réservation validée éditable (réaffectation de véhicule) ───
  it('update : réaffecte le véhicule d\'une réservation CONFIRMED (fleetId dérivé + re-check conflits)', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow({ status: 'CONFIRMED' })),
        findMany: jest.fn().mockResolvedValue([]), // aucun conflit sur le nouveau véhicule
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(evRow({ status: 'CONFIRMED', vehicleId: 'v2', fleetId: 'f2' })),
      },
    });
    const events = makeEvents({ assertVehicleAccess: jest.fn().mockResolvedValue('f2') });
    const svc = new ReservationsService(prisma, access('ALL'), events, makePerms());

    await svc.update(makeUser(), 'r1', { vehicleId: 'v2' });
    const data = (prisma as { vehicleEvent: { update: jest.Mock } }).vehicleEvent.update.mock.calls[0][0].data;
    expect(data.vehicleId).toBe('v2');
    expect(data.fleetId).toBe('f2'); // dérivé du nouveau véhicule, jamais du client
    expect((events as { assertVehicleAccess: jest.Mock }).assertVehicleAccess).toHaveBeenCalledWith(expect.anything(), 'v2');
  });

  // ─── P3 — création système (agent nocturne) ───
  it('systemConfirm : créneau LIBRE -> réservation CONFIRMED source SYSTEM', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicleEvent: { create: jest.Mock } };
    p.vehicleEvent.create.mockResolvedValue(evRow({ status: 'CONFIRMED' }));
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    const dto = await svc.systemConfirm({
      fleetId: 'f1', vehicleId: 'v1',
      start: new Date('2026-08-03T08:00:00Z'), end: new Date('2026-08-03T10:00:00Z'),
      title: 'Trajet récurrent → Carcassonne',
    });
    expect(dto?.status).toBe('CONFIRMED');
    const data = p.vehicleEvent.create.mock.calls[0][0].data;
    expect(data.source).toBe('SYSTEM');
    expect(data.status).toBe('CONFIRMED');
  });

  it('systemConfirm : créneau OCCUPÉ -> null (aucune création)', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findMany: jest.fn().mockResolvedValue([{ id: 'x', vehicle: { plate: 'AA-1' } }]),
        findUnique: jest.fn(), create: jest.fn(), update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    const dto = await svc.systemConfirm({
      fleetId: 'f1', vehicleId: 'v1',
      start: new Date('2026-08-03T08:00:00Z'), end: new Date('2026-08-03T10:00:00Z'), title: 'x',
    });
    expect(dto).toBeNull();
    expect((prisma as { vehicleEvent: { create: jest.Mock } }).vehicleEvent.create).not.toHaveBeenCalled();
  });
});
