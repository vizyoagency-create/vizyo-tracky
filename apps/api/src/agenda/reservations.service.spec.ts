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
    // `findUnique` : lu par `isVehicleFree` pour écarter un véhicule dont le boîtier s'est tu.
    // Par défaut le fixture décrit un véhicule SAIN (boîtier vu à l'instant) — sans quoi tous les
    // tests d'engagement basculeraient sur le chemin « dormant » sans le vouloir.
    vehicle: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest
        .fn()
        .mockResolvedValue({ outOfServiceReason: null, tracker: { id: 't1', lastSeenAt: new Date() } }),
    },
    trip: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    // Groupe de réservation (28/09) : par défaut, le véhicule n'a pas de groupe et la société n'en
    // connaît aucun — les tests qui en parlent posent les leurs.
    vehicleGroupAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    vehicleGroup: { findFirst: jest.fn().mockResolvedValue(null) },
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

const DAY = 86_400_000;
// Créneau FUTUR (une réservation ne se fait pas dans le passé — cf. garde request/update).
const SLOT = {
  startAt: new Date(Date.now() + 2 * DAY).toISOString(),
  endAt: new Date(Date.now() + 2 * DAY + 3 * 3_600_000).toISOString(),
};
// Créneau PASSÉ (pour tester le blocage + la consignation rétroactive « déjà effectuée »).
const PAST_SLOT = {
  startAt: new Date(Date.now() - 3 * DAY).toISOString(),
  endAt: new Date(Date.now() - 3 * DAY + 3 * 3_600_000).toISOString(),
};

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

  it('request : créneau PASSÉ sans option « déjà effectuée » -> 400 BadRequest', async () => {
    const svc = new ReservationsService(makePrisma(), access('ALL'), makeEvents(), makePerms(true));
    await expect(svc.request(makeUser(), { vehicleId: 'v1', ...PAST_SLOT })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('request : rétroactif (déjà effectuée) par un gestionnaire -> CONFIRMED à la date passée + metadata.retroactive, ignore le trajet réel', async () => {
    const prisma = makePrisma({
      // Un trajet réel EXISTE sur le créneau passé (preuve que la sortie a eu lieu) : ne doit PAS bloquer.
      trip: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ id: 't1' }) },
    });
    const p = prisma as { vehicleEvent: { create: jest.Mock } };
    p.vehicleEvent.create.mockResolvedValue(evRow({ status: 'CONFIRMED', metadata: { retroactive: true } }));
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    const dto = await svc.request(makeUser(), { vehicleId: 'v1', ...PAST_SLOT, retroactive: true });
    expect(dto.status).toBe('CONFIRMED');
    const data = p.vehicleEvent.create.mock.calls[0][0].data;
    expect(data.status).toBe('CONFIRMED');
    expect(data.metadata.retroactive).toBe(true);
  });

  it('request : rétroactif par un NON-gestionnaire -> 403 Forbidden (consigner est un acte de gestion)', async () => {
    const svc = new ReservationsService(makePrisma(), access('ALL'), makeEvents(), makePerms(false));
    await expect(
      svc.request(makeUser(), { vehicleId: 'v1', ...PAST_SLOT, retroactive: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
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

  // Troisième relecture du 29/09 (T1) : valider et annuler exigent de GÉRER le véhicule de la
  // réservation — les tests suivants montent donc un appelant qui le gère (`makePerms(true)`).
  it('confirm : conflit ferme détecté au pré-check -> 409 Conflict', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow()),
        findMany: jest.fn().mockResolvedValue([{ id: 'other', vehicle: { plate: 'AA-1' } }]),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
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
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
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
  it('update : réaffecte le véhicule d\'une réservation CONFIRMED (accès vérifié + re-check conflits), la société ne bouge pas', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow({ status: 'CONFIRMED' })),
        findMany: jest.fn().mockResolvedValue([]), // aucun conflit sur le nouveau véhicule
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(evRow({ status: 'CONFIRMED', vehicleId: 'v2' })),
      },
    });
    const events = makeEvents({ assertVehicleAccess: jest.fn().mockResolvedValue('f1') });
    // Contre-revue du 29/09 (R1) : changer le véhicule exige de GÉRER l'origine et la cible — ce test
    // passait avec un appelant qui ne gérait rien, c'est-à-dire qu'il verrouillait le trou.
    const svc = new ReservationsService(prisma, access('ALL'), events, makePerms(true));

    await svc.update(makeUser(), 'r1', { vehicleId: 'v2' });
    const data = (prisma as { vehicleEvent: { update: jest.Mock } }).vehicleEvent.update.mock.calls[0][0].data;
    expect(data.vehicleId).toBe('v2');
    expect(data.fleetId).toBeUndefined(); // même société : rien à réécrire
    expect((events as { assertVehicleAccess: jest.Mock }).assertVehicleAccess).toHaveBeenCalledWith(expect.anything(), 'v2');
  });

  /**
   * Revue du 29/09 (C4/C43) : ce test attendait l'INVERSE — une réservation de f1 passait chez f2 avec
   * son groupe et le contact du demandeur public. Une réservation ne change pas de société.
   */
  it('update : un véhicule d\'une AUTRE société est refusé (400), rien n\'est écrit', async () => {
    const prisma = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(evRow({ status: 'CONFIRMED' })),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const events = makeEvents({ assertVehicleAccess: jest.fn().mockResolvedValue('f2') });
    const svc = new ReservationsService(prisma, access('ALL'), events, makePerms(true));

    await expect(svc.update(makeUser({ role: UserRole.SUPER_ADMIN }), 'r1', { vehicleId: 'v2' })).rejects.toThrow(
      'Ce véhicule appartient à une autre société : une réservation ne change pas de société.',
    );
    expect((prisma as { vehicleEvent: { update: jest.Mock } }).vehicleEvent.update).not.toHaveBeenCalled();
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

/* ─────────────────────────────────────────────────────────────────────────────
 * DORMANCE — le vivier de réservation ne propose plus un véhicule dont le boîtier
 * s'est tu depuis plus de 7 jours (seuil « arrêter de COMPTER »).
 *
 * Cas réel : FV-941-LZ (89 j de silence) et FL-787-KV (52 j) ressortaient encore
 * comme réservables, y compris via l'attribution automatique et le lien public.
 * À l'inverse TEST-001-XX, sans boîtier, est un véhicule de parc parfaitement
 * exploitable : il DOIT rester réservable.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Ligne véhicule telle que la renvoie le `select` de computeSuggestions (tracker joint). */
function vehRow(id: string, tracker: { id: string; lastSeenAt: Date | null } | null = null) {
  return { id, plate: id.toUpperCase(), seats: 5, childSeats: 0, features: [], tracker };
}
function withVehicles(rows: unknown[]) {
  return makePrisma({ vehicle: { findMany: jest.fn().mockResolvedValue(rows) } });
}
/** Identifiants réellement envoyés aux requêtes d'occupation (= le vivier après filtrage). */
function queriedIds(prisma: unknown): string[] {
  const call = (prisma as { trip: { findMany: jest.Mock } }).trip.findMany.mock.calls[0];
  return call ? call[0].where.vehicleId.in : [];
}

describe('ReservationsService — dormance (vivier, seuil 7 j)', () => {
  it('suggest : boîtier muet depuis 89 j -> écarté du vivier, COMPTÉ, et même plus interrogé', async () => {
    const now = Date.now();
    const prisma = withVehicles([
      vehRow('v1', { id: 't1', lastSeenAt: new Date(now - 2 * 60_000) }), // parle il y a 2 min
      vehRow('v2', { id: 't2', lastSeenAt: new Date(now - 89 * DAY) }), // FV-941-LZ
    ]);
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    const res = await svc.suggest(makeUser(), SLOT);
    expect(res.vehicles.map((v) => v.vehicleId)).toEqual(['v1']);
    // Le chiffre client ne baisse jamais en silence : l'exclusion est exposée.
    expect(res.excludedDormant).toBe(1);
    // Filtré EN AMONT : inutile de chercher les conflits d'un véhicule déjà hors vivier (VPS 2 vCPU).
    expect(queriedIds(prisma)).toEqual(['v1']);
  });

  it('suggest : silencieux 2 h (boîtier garé en veille) -> RESTE dans le vivier', async () => {
    const now = Date.now();
    const prisma = withVehicles([
      vehRow('v1', { id: 't1', lastSeenAt: new Date(now - 2 * 3_600_000) }),
      vehRow('v2', { id: 't2', lastSeenAt: new Date(now - 6 * DAY) }), // week-end + congés : encore sous les 7 j
    ]);
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    const res = await svc.suggest(makeUser(), SLOT);
    expect(res.vehicles.map((v) => v.vehicleId).sort()).toEqual(['v1', 'v2']);
    expect(res.excludedDormant).toBe(0);
  });

  it('suggest : véhicule SANS boîtier (TEST-001-XX) ou boîtier qui n\'a JAMAIS émis -> reste réservable', async () => {
    const prisma = withVehicles([
      vehRow('v1', null), // aucun boîtier : « pas équipé » n'est pas « s'est tu »
      vehRow('v2', { id: 't2', lastSeenAt: null }), // boîtier posé, jamais connecté (SIM/APN KO)
    ]);
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    const res = await svc.suggest(makeUser(), SLOT);
    expect(res.vehicles.map((v) => v.vehicleId).sort()).toEqual(['v1', 'v2']);
    expect(res.excludedDormant).toBe(0);
  });

  it('suggest : le dormant réintègre le vivier dès que le boîtier ré-émet (aucune action manuelle)', async () => {
    const now = Date.now();
    const prisma = withVehicles([]);
    const findMany = (prisma as { vehicle: { findMany: jest.Mock } }).vehicle.findMany;
    findMany
      .mockResolvedValueOnce([vehRow('v1', { id: 't1', lastSeenAt: new Date(now - 52 * DAY) })]) // FL-787-KV
      .mockResolvedValueOnce([vehRow('v1', { id: 't1', lastSeenAt: new Date(now - 30_000) })]); // batterie rebranchée
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    const avant = await svc.suggest(makeUser(), SLOT);
    expect(avant.vehicles).toHaveLength(0);
    expect(avant.excludedDormant).toBe(1);

    const apres = await svc.suggest(makeUser(), SLOT);
    expect(apres.vehicles.map((v) => v.vehicleId)).toEqual(['v1']);
    expect(apres.excludedDormant).toBe(0);
  });

  it('suggest : tout le parc conforme est dormant -> vivier vide MAIS exclusion exposée (jamais un zéro muet)', async () => {
    const now = Date.now();
    const prisma = withVehicles([
      vehRow('v1', { id: 't1', lastSeenAt: new Date(now - 8 * DAY) }),
      vehRow('v2', { id: 't2', lastSeenAt: new Date(now - 40 * DAY) }),
    ]);
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    const res = await svc.suggest(makeUser(), SLOT);
    expect(res.vehicles).toHaveLength(0);
    expect(res.excludedDormant).toBe(2);
    expect(res.excludedImmobilized).toBe(0);
    expect(queriedIds(prisma)).toEqual([]); // aucune requête d'occupation inutile
  });

  it('request « ouverte » (sans véhicule) : l\'attribution automatique n\'affecte JAMAIS un dormant', async () => {
    const now = Date.now();
    const prisma = withVehicles([
      // Le dormant serait choisi EN PREMIER par le tri « sous-utilisé d'abord » (0 trajet depuis 89 j).
      vehRow('v2', { id: 't2', lastSeenAt: new Date(now - 89 * DAY) }),
      vehRow('v1', { id: 't1', lastSeenAt: new Date(now - 60_000) }),
    ]);
    const p = prisma as { vehicleEvent: { create: jest.Mock } };
    p.vehicleEvent.create.mockResolvedValue(evRow({ vehicleId: 'v1' }));
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    await svc.request(makeUser(), { ...SLOT });
    expect(p.vehicleEvent.create.mock.calls[0][0].data.vehicleId).toBe('v1');
  });

  it('request « ouverte » : parc conforme entièrement dormant -> le 400 NOMME l\'exclusion (pas un « aucun véhicule » trompeur)', async () => {
    const now = Date.now();
    const prisma = withVehicles([
      vehRow('v1', { id: 't1', lastSeenAt: new Date(now - 89 * DAY) }),
      vehRow('v2', { id: 't2', lastSeenAt: new Date(now - 52 * DAY) }),
    ]);
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    // Sans la mention, l'exploitant croit son agenda plein et cherche un conflit inexistant.
    await expect(svc.request(makeUser(), { ...SLOT })).rejects.toThrow(/2 véhicule\(s\) écarté\(s\).*muet/);
  });

  it('request « ouverte » : aucun dormant -> le message d\'origine reste INCHANGÉ (pas de bruit inventé)', async () => {
    const prisma = withVehicles([]); // parc vide : rien à écarter, rien à mentionner
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    await expect(svc.request(makeUser(), { ...SLOT })).rejects.toThrow(
      'Aucun véhicule libre ne correspond aux critères sur ce créneau.',
    );
  });

  it('availableForFleet (lien public) : le dormant n\'est pas proposé au demandeur', async () => {
    const now = Date.now();
    const prisma = withVehicles([
      vehRow('v1', { id: 't1', lastSeenAt: new Date(now - 60_000) }),
      vehRow('v2', { id: 't2', lastSeenAt: new Date(now - 20 * DAY) }),
    ]);
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    const res = await svc.availableForFleet('f1', SLOT.startAt, SLOT.endAt, undefined, { excludeRequested: true });
    expect(res.vehicles.map((v) => v.vehicleId)).toEqual(['v1']);
    // Le compteur EXISTE (info interne, consommée par les écrans authentifiés) ; le flux public
    // ne lit que `vehicles` — il ne doit jamais renvoyer ce chiffre au demandeur.
    expect(res.excludedDormant).toBe(1);
  });

  it('suggest : la dormance n\'écrase pas le comptage des immobilisés (deux motifs, deux compteurs)', async () => {
    const now = Date.now();
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          vehRow('v1', { id: 't1', lastSeenAt: new Date(now - 60_000) }), // libre
          vehRow('v2', { id: 't2', lastSeenAt: new Date(now - 60_000) }), // vivant mais immobilisé
          vehRow('v3', { id: 't3', lastSeenAt: new Date(now - 30 * DAY) }), // dormant
        ]),
      },
      vehicleEvent: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { blocksVehicle?: boolean } }) =>
          Promise.resolve(
            where?.blocksVehicle
              ? [{ vehicleId: 'v2', type: 'INCIDENT', startAt: new Date(now - 3_600_000), endAt: null }]
              : [],
          ),
        ),
        findUnique: jest.fn(), create: jest.fn(), update: jest.fn(),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms());

    const res = await svc.suggest(makeUser(), SLOT);
    expect(res.vehicles.map((v) => v.vehicleId)).toEqual(['v1']);
    expect(res.excludedDormant).toBe(1);
    expect(res.excludedImmobilized).toBe(1);
  });
});

/**
 * ENGAGEMENT d'un véhicule DORMANT — le dernier chemin par lequel un boîtier muet
 * continuait d'être réservé fermement.
 *
 * L'agent d'agenda nocturne ne passe PAS par le vivier de suggestion : il applique un motif
 * récurrent puis appelle directement `isVehicleFree`. Corriger le vivier ne le couvrait donc pas.
 */
describe('ReservationsService.isVehicleFree — dormance', () => {
  const J = 24 * 60 * 60 * 1000;
  const start = new Date('2026-07-27T08:00:00Z');
  const end = new Date('2026-07-27T10:00:00Z');

  function build(
    lastSeenAt: Date | null,
    trackerId: string | null = 't1',
    outOfServiceReason: string | null = null,
  ) {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({
          outOfServiceReason,
          tracker: trackerId ? { id: trackerId, lastSeenAt } : null,
        }),
      },
    }) as unknown as { vehicle: { findUnique: jest.Mock } };
    const svc = new ReservationsService(
      prisma as never, makeEvents(), access('ALL'), makePerms(), { emit: jest.fn() } as never,
    );
    return { svc, prisma };
  }

  it('REFUSE un véhicule dormant (89 j de silence)', async () => {
    const { svc } = build(new Date(Date.now() - 89 * J));
    await expect(svc.isVehicleFree('v1', start, end)).resolves.toBe(false);
  });

  it('⚠️ ACCEPTE un véhicule simplement garé depuis 2 h', async () => {
    const { svc } = build(new Date(Date.now() - 2 * 60 * 60 * 1000));
    await expect(svc.isVehicleFree('v1', start, end)).resolves.toBe(true);
  });

  it('⚠️ ACCEPTE un véhicule SANS boîtier — non équipé n’est pas dormant', async () => {
    const { svc } = build(null, null);
    await expect(svc.isVehicleFree('v1', start, end)).resolves.toBe(true);
  });

  it('⚠️ ACCEPTE un boîtier qui n’a JAMAIS émis (il ne s’est pas tu)', async () => {
    const { svc } = build(null);
    await expect(svc.isVehicleFree('v1', start, end)).resolves.toBe(true);
  });

  it('RÉINTÉGRATION : une trame fraîche suffit à le rendre engageable', async () => {
    const { svc } = build(new Date());
    await expect(svc.isVehicleFree('v1', start, end)).resolves.toBe(true);
  });

  /**
   * HORS SERVICE — le garde qui manquait sur CE chemin (23/09).
   *
   * `computeSuggestions` l'appliquait déjà, et son commentaire prétendait couvrir « l'attribution
   * automatique » : faux, l'agent nocturne ne passe pas par le vivier. Chez cdef31 les quatre
   * véhicules hors service se taisaient AUSSI, donc la dormance les retenait — par accident.
   */
  it('REFUSE un véhicule déclaré HORS SERVICE, même boîtier vu à l’instant', async () => {
    const { svc } = build(new Date(), 't1', 'ACCIDENT');
    await expect(svc.isVehicleFree('v1', start, end)).resolves.toBe(false);
  });

  it('REFUSE un HORS SERVICE sans boîtier (la fiche suffit)', async () => {
    const { svc } = build(null, null, 'TRACKER_UNPLUGGED');
    await expect(svc.isVehicleFree('v1', start, end)).resolves.toBe(false);
  });

  it('⚠️ ACCEPTE un véhicule EN SERVICE au boîtier frais — la garde ne mord pas à tort', async () => {
    const { svc } = build(new Date(), 't1', null);
    await expect(svc.isVehicleFree('v1', start, end)).resolves.toBe(true);
  });

  it('la lecture du boîtier n’a lieu QUE si le véhicule est par ailleurs libre', async () => {
    // Un conflit de réservation doit court-circuiter avant la requête supplémentaire.
    const prisma = makePrisma({
      vehicleEvent: {
        findMany: jest.fn().mockResolvedValue([{ id: 'conflit' }]),
        findUnique: jest.fn(), create: jest.fn(), update: jest.fn(),
      },
      vehicle: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    }) as unknown as { vehicle: { findUnique: jest.Mock } };
    const svc = new ReservationsService(
      prisma as never, makeEvents(), access('ALL'), makePerms(), { emit: jest.fn() } as never,
    );
    await expect(svc.isVehicleFree('v1', start, end)).resolves.toBe(false);
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * ── LOT 3C (2026-09-23) — REPRENDRE UN LOT DE RÉSERVATIONS ──────────────────────────────────
 *
 * Ce que ces tests protègent : un geste de MASSE se trompe en masse. Quatre garde-fous, et le
 * plus important est le premier — la simulation n'écrit RIEN, et c'est le mode par défaut.
 * Sans lui, on proposerait à un exploitant d'annuler cent réservations sans lui montrer
 * lesquelles.
 */
describe('ReservationsService.reorganiser — geste de masse', () => {
  const H = 3_600_000;
  /** Une réservation À VENIR (le passé est hors périmètre par construction). */
  const resa = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    vehiclePlate: 'AA-111-BB',
    type: 'RESERVATION',
    status: 'CONFIRMED',
    source: 'SYSTEM',
    startAt: new Date(Date.now() + 48 * H).toISOString(),
    endAt: new Date(Date.now() + 50 * H).toISOString(),
    ...over,
  });

  function monter(liste: unknown[]) {
    const events = makeEvents({ list: jest.fn().mockResolvedValue(liste) });
    const prisma = makePrisma();
    // ⚠️ ORDRE RÉEL du constructeur : (prisma, vehicleAccess, events, permissions, emitter).
    const svc = new ReservationsService(
      prisma as never, access('ALL'), events, makePerms(true), { emit: jest.fn() } as never,
    );
    return { svc, prisma, events };
  }

  const fenetre = () => ({
    from: new Date(Date.now() - 24 * H).toISOString(),
    to: new Date(Date.now() + 30 * 24 * H).toISOString(),
  });

  it('SIMULATION par défaut : compte, montre, et n’écrit RIEN', async () => {
    const { svc, prisma } = monter([resa(), resa({ id: 'e2' })]);
    const r = await svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
      ...fenetre(),
      action: 'annuler',
    });
    expect(r.simulation).toBe(true);
    expect(r.concernees).toBe(2);
    expect(r.appliquees).toBe(0);
    expect(r.apercu).toHaveLength(2);
    expect((prisma as unknown as { vehicleEvent: { update: jest.Mock } }).vehicleEvent.update).not.toHaveBeenCalled();
  });

  it('`origine: auto` par défaut : ne touche QUE les réservations de l’agent', async () => {
    const { svc } = monter([resa(), resa({ id: 'e2', source: 'MANUAL' })]);
    const r = await svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
      ...fenetre(),
      action: 'annuler',
    });
    expect(r.concernees).toBe(1); // la manuelle est épargnée
  });

  it('`origine: toutes` prend les deux', async () => {
    const { svc } = monter([resa(), resa({ id: 'e2', source: 'MANUAL' })]);
    const r = await svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
      ...fenetre(),
      action: 'annuler',
      origine: 'toutes',
    });
    expect(r.concernees).toBe(2);
  });

  /**
   * Recette du 28/09 (démo) : une demande déposée via le LIEN PUBLIC est écrite `source: SYSTEM`
   * (`systemRequest`), exactement comme une réservation de l'agent — et « Posées par l'agent →
   * Tout annuler » l'aurait annulée. Elle se reconnaît à `metadata.public`.
   */
  it('⚠️ une demande PUBLIQUE (SYSTEM + metadata.public) n’est PAS « posée par l’agent » : `auto` l’épargne, l’aperçu la nomme', async () => {
    const { svc } = monter([
      resa(),
      resa({ id: 'e2', metadata: { public: true, bookingRef: 'abc123', requester: 'Client test' } }),
      resa({ id: 'e3', source: 'MANUAL' }),
    ]);
    const auto = await svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
      ...fenetre(),
      action: 'annuler',
    });
    expect(auto.concernees).toBe(1);
    expect(auto.apercu.map((a) => a.origine)).toEqual(['agent']);

    const toutes = await svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
      ...fenetre(),
      action: 'annuler',
      origine: 'toutes',
    });
    expect(toutes.concernees).toBe(3);
    expect(toutes.apercu.map((a) => a.origine)).toEqual(['agent', 'public', 'manuelle']);
  });

  it('⚠️ n’emporte JAMAIS une réservation terminée ou déjà annulée', async () => {
    const { svc } = monter([resa({ status: 'DONE' }), resa({ id: 'e2', status: 'CANCELLED' })]);
    const r = await svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
      ...fenetre(),
      action: 'annuler',
      origine: 'toutes',
    });
    expect(r.concernees).toBe(0);
  });

  it('⚠️ n’emporte JAMAIS le passé, même si la fenêtre demandée le couvre', async () => {
    const { svc } = monter([resa({ startAt: new Date(Date.now() - 5 * H).toISOString() })]);
    const r = await svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
      ...fenetre(),
      action: 'annuler',
    });
    expect(r.concernees).toBe(0);
  });

  it('refuse une fenêtre entièrement passée, au lieu de ne rien faire en silence', async () => {
    const { svc } = monter([]);
    await expect(
      svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
        from: new Date(Date.now() - 10 * H).toISOString(),
        to: new Date(Date.now() - 2 * H).toISOString(),
        action: 'annuler',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('« decaler » sans minutes : refus explicite (0 n’est pas un décalage)', async () => {
    const { svc } = monter([resa()]);
    await expect(
      svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, { ...fenetre(), action: 'decaler' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un décalage qui ramènerait la réservation dans le passé est REFUSÉ, avec son motif', async () => {
    const { svc } = monter([resa({ startAt: new Date(Date.now() + 2 * H).toISOString(), endAt: new Date(Date.now() + 3 * H).toISOString() })]);
    const r = await svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
      ...fenetre(),
      action: 'decaler',
      decalageMinutes: -600, // −10 h
      simulation: false,
    });
    expect(r.appliquees).toBe(0);
    expect(r.refusees).toHaveLength(1);
    expect(r.refusees[0].motif).toMatch(/passé/);
    expect(r.refusees[0].plate).toBe('AA-111-BB'); // le refus NOMME la réservation
  });

  it('action inconnue : refus', async () => {
    const { svc } = monter([]);
    await expect(
      svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
        ...fenetre(),
        action: 'supprimer' as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * LA DÉCISION NE LAISSAIT AUCUNE TRACE.
 *
 * Relevé le 2026-09-24 en recette : deux demandes de « Client test » étaient passées à CONFIRMED
 * et rien, nulle part, ne permettait de dire qui les avait validées ni quand. Le DÉPÔT d'une
 * demande publique était journalisé (`public_booking_submitted`), la DÉCISION ne l'était pas —
 * exactement l'inverse de ce qu'il faut : chez un client dont le standard valide les demandes des
 * conducteurs, c'est la décision qui engage.
 */
describe('ReservationsService — la décision laisse une trace', () => {
  const journal = () => ({ record: jest.fn() });

  const prismaAvec = (status: string) =>
    makePrisma({
      vehicleEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1', fleetId: 'f1', vehicleId: 'v1', status,
          type: 'RESERVATION', startAt: new Date('2026-10-01T08:00:00Z'),
          endAt: new Date('2026-10-01T10:00:00Z'), metadata: null,
        }),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({
          id: 'r1', fleetId: 'f1', vehicleId: 'v1', status: 'CANCELLED',
          type: 'RESERVATION', category: null, severity: null, title: 'Sortie', description: null,
          startAt: new Date('2026-10-01T08:00:00Z'), endAt: new Date('2026-10-01T10:00:00Z'),
          allDay: false, blocksVehicle: true, odometerKm: null, planId: null, linkedEventId: null,
          resolvedAt: new Date('2026-10-01T09:00:00Z'), source: 'MANUAL',
          createdAt: new Date('2026-09-01T08:00:00Z'), updatedAt: new Date('2026-09-24T01:00:00Z'),
          vehicle: { plate: 'AA-123-BB' }, metadata: null,
        }),
      },
    });

  it('journalise un REFUS quand la demande était en attente', async () => {
    const j = journal();
    const svc = new ReservationsService(
      prismaAvec('REQUESTED'), access('ALL'), makeEvents(), makePerms(true), undefined, j as never,
    );
    await svc.cancel(makeUser(), 'r1');
    expect(j.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reservation_refusee', category: 'RESERVATION' }),
    );
  });

  /** ⚠️ Refuser une demande et annuler une réservation ferme sont deux gestes différents. */
  it('journalise une ANNULATION quand la réservation était déjà ferme', async () => {
    const j = journal();
    const svc = new ReservationsService(
      prismaAvec('CONFIRMED'), access('ALL'), makeEvents(), makePerms(true), undefined, j as never,
    );
    await svc.cancel(makeUser(), 'r1');
    expect(j.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reservation_annulee' }),
    );
  });

  /** F16 (28/09) : le demandeur d'une demande publique apprenait la validation, jamais le refus. */
  it('un REFUS émet reservation.refused — le notifier prévient le demandeur public', async () => {
    const emitter = { emit: jest.fn() };
    const svc = new ReservationsService(
      prismaAvec('REQUESTED'), access('ALL'), makeEvents(), makePerms(true), emitter as never, journal() as never,
    );
    await svc.cancel(makeUser(), 'r1');
    expect(emitter.emit).toHaveBeenCalledWith(
      'reservation.refused',
      expect.objectContaining({ fleetId: 'f1', vehiclePlate: 'AA-123-BB', startAt: '2026-10-01T08:00:00.000Z' }),
    );
  });

  it('…mais l\'ANNULATION d\'une réservation ferme n\'est pas un refus : rien n\'est émis', async () => {
    const emitter = { emit: jest.fn() };
    const svc = new ReservationsService(
      prismaAvec('CONFIRMED'), access('ALL'), makeEvents(), makePerms(true), emitter as never, journal() as never,
    );
    await svc.cancel(makeUser(), 'r1');
    expect(emitter.emit).not.toHaveBeenCalledWith('reservation.refused', expect.anything());
  });

  it('nomme QUI a décidé — sans ça la trace ne sert à rien', async () => {
    const j = journal();
    const svc = new ReservationsService(
      prismaAvec('REQUESTED'), access('ALL'), makeEvents(), makePerms(true), undefined, j as never,
    );
    await svc.cancel(makeUser({ id: 'standard-42' }), 'r1');
    expect(j.record).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ parUtilisateur: 'standard-42' }) }),
    );
  });

  /** Un journal indisponible ne doit JAMAIS empêcher une décision d'aboutir. */
  it('aboutit même sans journal', async () => {
    const svc = new ReservationsService(
      prismaAvec('CONFIRMED'), access('ALL'), makeEvents(), makePerms(true),
    );
    await expect(svc.cancel(makeUser(), 'r1')).resolves.toBeDefined();
  });
});

/**
 * LE MOTIF SAISI DISPARAISSAIT DE L'ÉCRAN.
 *
 * Relevé en recette le 2026-09-24 : on tape « Ramassage scolaire secteur nord » dans le champ
 * Motif — que le formulaire propose lui-même en exemple — et le calendrier affiche « Réservation ».
 * Le texte était bien enregistré (`metadata.reason`), mais la grille lit `title`, qui valait
 * toujours la valeur générique. Un champ dont la saisie n'apparaît nulle part est un champ qui
 * ment sur son utilité.
 */
describe('ReservationsService — le motif devient le titre', () => {
  const creer = () => {
    const create = jest.fn().mockResolvedValue({
      id: 'r9', fleetId: 'f1', vehicleId: 'v1', status: 'CONFIRMED',
      type: 'RESERVATION', category: null, severity: null, title: 'x', description: null,
      startAt: new Date('2026-10-01T08:00:00Z'), endAt: new Date('2026-10-01T10:00:00Z'),
      allDay: false, blocksVehicle: true, odometerKm: null, planId: null, linkedEventId: null,
      resolvedAt: null, source: 'MANUAL', metadata: null,
      createdAt: new Date(), updatedAt: new Date(), vehicle: { plate: 'AA-1' },
    });
    const prisma = makePrisma({
      vehicleEvent: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), create, update: jest.fn() },
    });
    return { prisma, create };
  };

  const demande = (over: Record<string, unknown>) => ({
    vehicleId: 'v1',
    startAt: new Date(Date.now() + 86_400_000).toISOString(),
    endAt: new Date(Date.now() + 90_000_000).toISOString(),
    ...over,
  });

  it('reprend le motif comme titre quand aucun titre explicite n’est donné', async () => {
    const { prisma, create } = creer();
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await svc.request(makeUser(), demande({ reason: 'Ramassage scolaire secteur nord' }) as never);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ title: 'Ramassage scolaire secteur nord' }),
      }),
    );
  });

  /** Un titre explicite (API, import) prime toujours sur le motif. */
  it('laisse le titre explicite gagner', async () => {
    const { prisma, create } = creer();
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await svc.request(makeUser(), demande({ title: 'Navette', reason: 'autre chose' }) as never);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Navette' }) }),
    );
  });

  it('retombe sur « Réservation » quand ni l’un ni l’autre n’est fourni', async () => {
    const { prisma, create } = creer();
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await svc.request(makeUser(), demande({}) as never);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Réservation' }) }),
    );
  });

  /** ⚠️ Le motif reste AUSSI dans la metadata : le flux public et les exports l'y lisent. */
  it('conserve le motif dans la metadata', async () => {
    const { prisma, create } = creer();
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await svc.request(makeUser(), demande({ reason: 'Sortie piscine' }) as never);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ metadata: expect.objectContaining({ reason: 'Sortie piscine' }) }),
      }),
    );
  });
});

describe('ReservationsService — sièges auto : le stock de la société borne la réservation (2026-09-28)', () => {
  /** Stock mocké : `assertAvailable` refuse (409) dès que `manque` est vrai. */
  const makeChildSeats = (manque = false) =>
    ({
      assertAvailable: jest.fn().mockImplementation(() =>
        manque ? Promise.reject(new ConflictException('Sièges auto insuffisants sur ce créneau : il manque 1 siège(s) « Bébé »')) : Promise.resolve(),
      ),
      availability: jest.fn().mockResolvedValue({
        startAt: '', endAt: '', stock: { baby: 2, child: 3 }, engaged: { baby: 0, child: 0 }, available: { baby: 2, child: 3 },
      }),
    }) as never;
  const creer = (childSeats: unknown, over: Record<string, unknown> = {}) => {
    const create = jest.fn().mockResolvedValue(evRow({ status: 'CONFIRMED', metadata: {} }));
    const prisma = makePrisma({
      vehicleEvent: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), create, update: jest.fn(), ...over },
    });
    // Position 7 du constructeur : (prisma, accès, events, perms, emitter, journal, sièges).
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true), undefined, undefined, childSeats as never);
    return { prisma, create, svc };
  };

  it('request : le besoin de sièges est vérifié contre le stock, et écrit PROPRE dans les critères', async () => {
    const childSeats = makeChildSeats(false);
    const { create, svc } = creer(childSeats);
    await svc.request(makeUser(), { vehicleId: 'v1', ...SLOT, criteria: { minSeats: 4, childSeatsBaby: 1, childSeatsChild: '2' as unknown as number } });
    const cs = childSeats as unknown as { assertAvailable: jest.Mock };
    // Le véhicule visé est passé : ses sièges à bord comptent avant le stock (28/09, après-midi).
    expect(cs.assertAvailable).toHaveBeenCalledWith('f1', new Date(SLOT.startAt), new Date(SLOT.endAt), { baby: 1, child: 2 }, { vehicleId: 'v1' });
    expect(create.mock.calls[0][0].data.metadata.criteria).toEqual({ minSeats: 4, childSeatsBaby: 1, childSeatsChild: 2 });
  });

  it('request : stock insuffisant -> 409, rien n\'est créé (même pour une simple DEMANDE)', async () => {
    const { create, svc } = creer(makeChildSeats(true));
    await expect(
      svc.request(makeUser(), { vehicleId: 'v1', ...SLOT, criteria: { childSeatsBaby: 3 } }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });

  it('request : une consignation RÉTROACTIVE n\'engage plus aucun siège (pas de vérification)', async () => {
    const childSeats = makeChildSeats(true);
    const { svc } = creer(childSeats);
    await svc.request(makeUser(), { vehicleId: 'v1', ...PAST_SLOT, retroactive: true, criteria: { childSeatsBaby: 3 } });
    expect((childSeats as unknown as { assertAvailable: jest.Mock }).assertAvailable).not.toHaveBeenCalled();
  });

  it('confirm : revérifie le stock en excluant la demande ET ses sœurs (même bookingRef)', async () => {
    const childSeats = makeChildSeats(false);
    const row = evRow({ status: 'REQUESTED', metadata: { public: true, bookingRef: 'g1', criteria: { childSeatsChild: 2 } } });
    const { svc } = creer(childSeats, {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({ ...row, status: 'CONFIRMED' }),
    });
    await svc.confirm(makeUser(), 'r1', {});
    expect((childSeats as unknown as { assertAvailable: jest.Mock }).assertAvailable).toHaveBeenCalledWith(
      'f1', row.startAt, row.endAt, { baby: 0, child: 2 }, { vehicleId: 'v1', excludeId: 'r1', excludeBookingRef: 'g1' },
    );
  });

  it('confirm : le stock a été pris depuis le dépôt -> 409, la demande reste en attente', async () => {
    const row = evRow({ status: 'REQUESTED', metadata: { criteria: { childSeatsBaby: 1 } } });
    const { prisma, svc } = creer(makeChildSeats(true), { findUnique: jest.fn().mockResolvedValue(row) });
    await expect(svc.confirm(makeUser(), 'r1', {})).rejects.toBeInstanceOf(ConflictException);
    expect((prisma as unknown as { vehicleEvent: { update: jest.Mock } }).vehicleEvent.update).not.toHaveBeenCalled();
  });

  it('update : un besoin revu à la hausse se vérifie (en s\'excluant soi-même) ; un motif seul ne relit pas le stock', async () => {
    const childSeats = makeChildSeats(false);
    // Réservation À VENIR : depuis la revue du 29/09 (C44), le stock se juge sur la partie à venir —
    // une réservation entièrement passée n'engage plus aucun siège.
    const row = evRow({ status: 'CONFIRMED', metadata: { criteria: { childSeatsBaby: 1 } }, startAt: new Date(SLOT.startAt), endAt: new Date(SLOT.endAt) });
    const { svc } = creer(childSeats, {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(row),
    });
    await svc.update(makeUser(), 'r1', { reason: 'nouveau motif' });
    const cs = childSeats as unknown as { assertAvailable: jest.Mock };
    expect(cs.assertAvailable).not.toHaveBeenCalled();
    await svc.update(makeUser(), 'r1', { criteria: { childSeatsBaby: 2 } });
    expect(cs.assertAvailable).toHaveBeenCalledWith('f1', row.startAt, row.endAt, { baby: 2, child: 0 }, { vehicleId: 'v1', excludeId: 'r1', excludeBookingRef: null });
  });

  it('suggest : avec un besoin, un véhicule libre que les sièges ne couvrent pas est ÉCARTÉ et COMPTÉ ; l’équipé passe devant', async () => {
    // Stock : 0 bébé disponible. v1 a 1 bébé à bord (rien au stock) ; v2 n'a rien (1 bébé au stock → impossible).
    const childSeats = {
      availability: jest.fn().mockResolvedValue({
        startAt: '', endAt: '', policy: 'STOCK_OR_INSTALLED', total: { baby: 1, child: 0 }, installed: { baby: 1, child: 0 },
        stock: { baby: 0, child: 0 }, engaged: { baby: 0, child: 0 }, available: { baby: 0, child: 0 },
      }),
      assertAvailable: jest.fn().mockResolvedValue(undefined),
    } as never;
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'v2', plate: 'BB-2', seats: 5, childSeatsBaby: 0, childSeatsChild: 0, features: [] },
          { id: 'v1', plate: 'AA-1', seats: 5, childSeatsBaby: 1, childSeatsChild: 0, features: [] },
        ]),
      },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(), undefined, undefined, childSeats);
    const res = await svc.suggest(makeUser(), { ...SLOT, criteria: { childSeatsBaby: 1 } });
    expect(res.vehicles.map((v) => v.vehicleId)).toEqual(['v1']);
    expect(res.vehicles[0].childSeatsInstalled).toEqual({ baby: 1, child: 0 });
    expect(res.vehicles[0].childSeatsFromStock).toEqual({ baby: 0, child: 0 });
    expect(res.excludedChildSeats).toBe(1);
    // Le stock est lu avec les demandes en attente quand le flux public le demande.
    await svc.availableForFleet('f1', SLOT.startAt, SLOT.endAt, { childSeatsBaby: 1 }, { excludeRequested: true });
    expect((childSeats as unknown as { availability: jest.Mock }).availability).toHaveBeenLastCalledWith(
      'f1', expect.any(Date), expect.any(Date), { includeRequested: true },
    );
  });

  it('sans service de sièges (specs historiques, module absent) : aucun contrôle, aucune erreur', async () => {
    const { create, svc } = creer(undefined);
    await svc.request(makeUser(), { vehicleId: 'v1', ...SLOT, criteria: { childSeatsBaby: 99 } });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('ReservationsService — hors service : le choix EXPLICITE d’un véhicule est refusé (2026-09-28)', () => {
  /** Véhicule déclaré accidenté par un super-admin ; boîtier qui parle encore (le cas qui passait). */
  const horsService = () =>
    jest.fn().mockResolvedValue({ outOfServiceReason: 'ACCIDENT', plate: 'HS-001-XX', tracker: { id: 't1', lastSeenAt: new Date() } });

  it('request avec vehicleId sur un véhicule hors service -> 409 qui nomme la plaque et le motif', async () => {
    const prisma = makePrisma({ vehicle: { findMany: jest.fn().mockResolvedValue([]), findUnique: horsService() } });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await expect(svc.request(makeUser(), { vehicleId: 'v1', ...SLOT })).rejects.toThrow(/HS-001-XX .*hors service \(accidenté\)/);
    expect((prisma as { vehicleEvent: { create: jest.Mock } }).vehicleEvent.create).not.toHaveBeenCalled();
  });

  it('request rétroactif (sortie déjà faite) : consigner ne promet rien -> accepté même hors service', async () => {
    const prisma = makePrisma({ vehicle: { findMany: jest.fn().mockResolvedValue([]), findUnique: horsService() } });
    (prisma as { vehicleEvent: { create: jest.Mock } }).vehicleEvent.create.mockResolvedValue(evRow({ status: 'CONFIRMED', metadata: { retroactive: true } }));
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await expect(svc.request(makeUser(), { vehicleId: 'v1', ...PAST_SLOT, retroactive: true })).resolves.toMatchObject({ status: 'CONFIRMED' });
  });

  it('confirm : la demande porte un véhicule déclaré hors service depuis son dépôt -> 409, rien n’est validé', async () => {
    const prisma = makePrisma({
      vehicle: { findMany: jest.fn().mockResolvedValue([]), findUnique: horsService() },
      vehicleEvent: { findUnique: jest.fn().mockResolvedValue(evRow()), findMany: jest.fn().mockResolvedValue([]), update: jest.fn(), create: jest.fn() },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await expect(svc.confirm(makeUser(), 'r1', {})).rejects.toBeInstanceOf(ConflictException);
    expect((prisma as { vehicleEvent: { update: jest.Mock } }).vehicleEvent.update).not.toHaveBeenCalled();
  });

  it('update : réaffecter vers un véhicule hors service -> 409 ; changer le motif seul ne lit pas le véhicule', async () => {
    const findUnique = horsService();
    const row = evRow({ status: 'CONFIRMED' });
    const prisma = makePrisma({
      vehicle: { findMany: jest.fn().mockResolvedValue([]), findUnique },
      vehicleEvent: { findUnique: jest.fn().mockResolvedValue(row), findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue(row), create: jest.fn() },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await svc.update(makeUser(), 'r1', { reason: 'autre motif' });
    expect(findUnique).not.toHaveBeenCalled();
    await expect(svc.update(makeUser(), 'r1', { vehicleId: 'v2' })).rejects.toBeInstanceOf(ConflictException);
  });
});

/**
 * ── GROUPE DE RÉSERVATION (refonte UX du 28/09, point 9) ──────────────────────────────────────
 *
 * « Groupe du véhicule ≠ groupe de la réservation. » La réservation porte celui qui UTILISE le
 * véhicule ; par défaut celui du véhicule, modifiable ; jamais écrit sur le véhicule.
 */
describe('ReservationsService — le groupe qui utilise le véhicule', () => {
  const creer = (over: Record<string, unknown> = {}) => {
    const create = jest.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: 'r9', fleetId: 'f1', vehicleId: 'v1', status: 'CONFIRMED',
      type: 'RESERVATION', category: null, severity: null, title: 'x', description: null,
      startAt: new Date('2026-10-01T08:00:00Z'), endAt: new Date('2026-10-01T10:00:00Z'),
      allDay: false, blocksVehicle: true, odometerKm: null, planId: null, linkedEventId: null,
      resolvedAt: null, source: 'MANUAL', metadata: args.data['metadata'] ?? null,
      createdAt: new Date(), updatedAt: new Date(), vehicle: { plate: 'AA-1' },
    }));
    const update = jest.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: 'r1', fleetId: 'f1', vehicleId: 'v1', status: 'CONFIRMED',
      type: 'RESERVATION', category: null, severity: null, title: 'x', description: null,
      startAt: new Date(Date.now() + 86_400_000), endAt: new Date(Date.now() + 90_000_000),
      allDay: false, blocksVehicle: true, odometerKm: null, planId: null, linkedEventId: null,
      resolvedAt: null, source: 'MANUAL', metadata: args.data['metadata'] ?? null,
      createdAt: new Date(), updatedAt: new Date(), vehicle: { plate: 'AA-1' },
    }));
    const prisma = makePrisma({
      vehicleEvent: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), create, update },
      vehicleGroupAssignment: {
        findFirst: jest.fn().mockResolvedValue({ group: { id: 'g-nord', name: 'Nord' } }),
      },
      vehicleGroup: {
        findFirst: jest.fn().mockImplementation(async ({ where }: { where: { id: string; fleetId: string } }) =>
          where.id === 'g-sud' && where.fleetId === 'f1' ? { id: 'g-sud', name: 'Sud' } : null,
        ),
      },
      ...over,
    });
    return { prisma, create, update };
  };

  const demande = (over: Record<string, unknown> = {}) => ({
    vehicleId: 'v1',
    startAt: new Date(Date.now() + 86_400_000).toISOString(),
    endAt: new Date(Date.now() + 90_000_000).toISOString(),
    ...over,
  });

  const metaDe = (mock: jest.Mock) => (mock.mock.calls[0][0].data as { metadata: Record<string, unknown> }).metadata;

  it('par défaut, une demande hérite du groupe du véhicule', async () => {
    const { prisma, create } = creer();
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await svc.request(makeUser(), demande() as never);
    expect(metaDe(create)['group']).toEqual({ id: 'g-nord', name: 'Nord' });
  });

  it('un groupe de la société choisi à la demande l’emporte, et son nom vient de la base', async () => {
    const { prisma, create } = creer();
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await svc.request(makeUser(), demande({ group: { id: 'g-sud', name: 'n’importe quoi' } }) as never);
    expect(metaDe(create)['group']).toEqual({ id: 'g-sud', name: 'Sud' });
  });

  it('un groupe saisi en texte libre est gardé sans id', async () => {
    const { prisma, create } = creer();
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await svc.request(makeUser(), demande({ group: { id: null, name: '  Foyer des Lilas ' } }) as never);
    expect(metaDe(create)['group']).toEqual({ id: null, name: 'Foyer des Lilas' });
  });

  /** ⚠️ Un id de groupe d'une AUTRE société est refusé : on ne range pas une réservation chez un autre client. */
  it('refuse un id de groupe inconnu dans la société (400)', async () => {
    const { prisma } = creer();
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await expect(
      svc.request(makeUser(), demande({ group: { id: 'g-autre-societe', name: 'X' } }) as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('à la validation, le groupe choisi prime ; sinon celui déjà posé ; sinon celui du véhicule', async () => {
    const { prisma, update } = creer();
    const findUnique = (prisma as { vehicleEvent: { findUnique: jest.Mock } }).vehicleEvent.findUnique;
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));

    findUnique.mockResolvedValue(evRow({ status: 'REQUESTED', metadata: { requesterId: 'u1' } }));
    await svc.confirm(makeUser(), 'r1', { group: { id: 'g-sud', name: '' } });
    expect((update.mock.calls[0][0].data as { metadata: Record<string, unknown> }).metadata['group']).toEqual({ id: 'g-sud', name: 'Sud' });

    findUnique.mockResolvedValue(evRow({ status: 'REQUESTED', metadata: { group: { id: null, name: 'Libre' } } }));
    await svc.confirm(makeUser(), 'r1', {});
    expect((update.mock.calls[1][0].data as { metadata: Record<string, unknown> }).metadata['group']).toEqual({ id: null, name: 'Libre' });

    findUnique.mockResolvedValue(evRow({ status: 'REQUESTED', metadata: null }));
    await svc.confirm(makeUser(), 'r1', {});
    expect((update.mock.calls[2][0].data as { metadata: Record<string, unknown> }).metadata['group']).toEqual({ id: 'g-nord', name: 'Nord' });
  });

  it('à l’édition, un objet remplace, null retire, absent ne touche à rien', async () => {
    const { prisma, update } = creer();
    const findUnique = (prisma as { vehicleEvent: { findUnique: jest.Mock } }).vehicleEvent.findUnique;
    findUnique.mockResolvedValue(evRow({ status: 'CONFIRMED', metadata: { group: { id: 'g-nord', name: 'Nord' }, reason: 'x' } }));
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));

    await svc.update(makeUser(), 'r1', { group: { id: null, name: 'Sud-Ouest' } });
    expect((update.mock.calls[0][0].data as { metadata: Record<string, unknown> }).metadata).toEqual(
      expect.objectContaining({ reason: 'x', group: { id: null, name: 'Sud-Ouest' } }),
    );

    await svc.update(makeUser(), 'r1', { group: null });
    expect((update.mock.calls[1][0].data as { metadata: Record<string, unknown> }).metadata['group']).toBeNull();

    await svc.update(makeUser(), 'r1', { reason: 'y' });
    expect((update.mock.calls[2][0].data as { metadata: Record<string, unknown> }).metadata['group']).toEqual({ id: 'g-nord', name: 'Nord' });
  });

  /** Le groupe du VÉHICULE n'est jamais touché : aucune écriture sur vehicle ni sur ses liens. */
  it('n’écrit jamais le groupe sur le véhicule', async () => {
    const { prisma, create } = creer();
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    await svc.request(makeUser(), demande({ group: { id: 'g-sud', name: 'Sud' } }) as never);
    expect(create).toHaveBeenCalledTimes(1);
    const p = prisma as { vehicle: Record<string, jest.Mock>; vehicleGroupAssignment: Record<string, jest.Mock> };
    expect(p.vehicle['update']).toBeUndefined();
    expect(p.vehicleGroupAssignment['create']).toBeUndefined();
    expect(p.vehicleGroupAssignment['update']).toBeUndefined();
  });
});

/**
 * ── RÉAFFECTER (refonte UX du 28/09, point 4) — « un véhicule part au garage une semaine » ──────
 */
describe('ReservationsService.reaffecter — passer une réservation sur un autre véhicule', () => {
  const H = 3_600_000;
  const ligne = (over: Record<string, unknown> = {}) =>
    evRow({
      status: 'CONFIRMED',
      startAt: new Date(Date.now() + 48 * H),
      endAt: new Date(Date.now() + 50 * H),
      metadata: { criteria: { minSeats: 7 } },
      ...over,
    });

  function monter(row: Record<string, unknown>, vivier: string[]) {
    const update = jest.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...ligne(row), ...args.data, vehicle: { plate: 'BB-2' } }));
    const prisma = makePrisma({
      vehicleEvent: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(ligne(row)), create: jest.fn(), update },
    });
    const svc = new ReservationsService(prisma, access('ALL'), makeEvents(), makePerms(true));
    jest.spyOn(svc, 'suggest').mockResolvedValue({
      startAt: '', endAt: '', excludedUnknownCapacity: 0, excludedImmobilized: 0, excludedDormant: 0,
      vehicles: vivier.map((id) => ({ vehicleId: id, vehiclePlate: id, seats: 9, features: [], utilizationRatio: 0.1, underutilized: true })),
    });
    return { svc, prisma, update };
  }

  it('`auto` : prend le premier véhicule libre et conforme qui n’est PAS celui d’origine, avec les critères de la réservation', async () => {
    const { svc, update } = monter({ vehicleId: 'v1' }, ['v1', 'v2', 'v3']);
    await svc.reaffecter(makeUser(), 'r1', {});
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ vehicleId: 'v2' }) }));
    expect((svc.suggest as jest.Mock).mock.calls[0][1]).toMatchObject({ criteria: { minSeats: 7 }, fleetId: 'f1' });
  });

  it('cible explicite : passe par update (conflits, hors service, sièges revérifiés là)', async () => {
    const { svc, update } = monter({ vehicleId: 'v1' }, []);
    await svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v9' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ vehicleId: 'v9' }) }));
    expect(svc.suggest).not.toHaveBeenCalled();
  });

  it('refuse : même véhicule (400), aucun autre libre (409), réservation close ou passée (400)', async () => {
    await expect(monter({ vehicleId: 'v1' }, ['v1']).svc.reaffecter(makeUser(), 'r1', {})).rejects.toBeInstanceOf(ConflictException);
    await expect(monter({ vehicleId: 'v1' }, []).svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v1' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(monter({ vehicleId: 'v1', status: 'CANCELLED' }, ['v2']).svc.reaffecter(makeUser(), 'r1', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      monter({ vehicleId: 'v1', startAt: new Date(Date.now() - 50 * H), endAt: new Date(Date.now() - 48 * H) }, ['v2']).svc.reaffecter(makeUser(), 'r1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ReservationsService.reorganiser — réaffecter un lot, et les comptes qui expliquent un lot vide', () => {
  const H = 3_600_000;
  const resa = (over: Record<string, unknown> = {}) => ({
    id: 'e1', vehicleId: 'v1', vehiclePlate: 'AA-111-BB', type: 'RESERVATION', status: 'CONFIRMED', source: 'SYSTEM',
    startAt: new Date(Date.now() + 48 * H).toISOString(), endAt: new Date(Date.now() + 50 * H).toISOString(),
    ...over,
  });
  const fenetre = () => ({ from: new Date(Date.now() - 24 * H).toISOString(), to: new Date(Date.now() + 30 * 24 * H).toISOString() });

  it('la simulation rend les totaux par origine et par véhicule — même quand le lot est vide', async () => {
    const events = makeEvents({
      list: jest.fn().mockResolvedValue([
        resa(), // agent, v1
        resa({ id: 'e2', vehicleId: 'v2', vehiclePlate: 'CC-3', source: 'MANUAL' }),
        resa({ id: 'e3', vehicleId: 'v2', vehiclePlate: 'CC-3', source: 'SYSTEM', metadata: { public: true } }),
      ]),
    });
    const svc = new ReservationsService(makePrisma(), access('ALL'), events, makePerms(true), { emit: jest.fn() } as never);
    const r = await svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, { ...fenetre(), action: 'annuler', origine: 'auto', vehicleId: 'v2' });
    expect(r.concernees).toBe(0); // v2 n'a rien de l'agent
    expect(r.totaux).toEqual({ agent: 1, public: 1, manuelle: 1 });
    expect(r.parVehicule).toEqual([{ vehicleId: 'v1', plate: 'AA-111-BB', n: 1 }]); // pour l'origine « agent »
    // Le filtre véhicule se fait en mémoire : la liste a été demandée pour TOUS les véhicules.
    expect((events as unknown as { list: jest.Mock }).list.mock.calls[0][1]).not.toHaveProperty('vehicleId');
  });

  it('`reaffecter` réaffecte chaque réservation du lot (auto), et remonte les refus ligne par ligne', async () => {
    const events = makeEvents({ list: jest.fn().mockResolvedValue([resa(), resa({ id: 'e2' })]) });
    const svc = new ReservationsService(makePrisma(), access('ALL'), events, makePerms(true), { emit: jest.fn() } as never);
    const reaffecter = jest
      .spyOn(svc, 'reaffecter')
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new ConflictException('Aucun autre véhicule libre et conforme sur ce créneau.'));
    const r = await svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, {
      ...fenetre(), action: 'reaffecter', origine: 'toutes', vehicleId: 'v1', simulation: false,
    });
    expect(reaffecter).toHaveBeenCalledTimes(2);
    // Coupe au début de la fenêtre (R2), écriture silencieuse : la réorganisation prévient elle-même (R3).
    expect(reaffecter).toHaveBeenCalledWith(
      expect.anything(), 'e1', { versVehicleId: 'auto', aPartirDe: expect.any(String) }, { silencieux: true },
    );
    expect(r.appliquees).toBe(1);
    expect(r.refusees).toEqual([expect.objectContaining({ motif: 'Aucun autre véhicule libre et conforme sur ce créneau.' })]);
  });

  it('refuse de réaffecter vers le véhicule qu’on libère', async () => {
    const svc = new ReservationsService(makePrisma(), access('ALL'), makeEvents(), makePerms(true), { emit: jest.fn() } as never);
    await expect(
      svc.reorganiser({ role: 'FLEET_ADMIN', fleetId: 'f1' } as never, { ...fenetre(), action: 'reaffecter', vehicleId: 'v1', versVehicleId: 'v1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * ── REVUE ADVERSARIALE DU 29/09 — RÉSERVATIONS ─────────────────────────────────────────────────
 *
 * Chaque cas ci-dessous a été rejoué dans le code par deux sceptiques avant d'être corrigé :
 * plancher de places (C0), demande en attente contrôlée (C1), stock de sièges sans soi-même (C2),
 * « aucun groupe » explicite (C3), pas de changement de société (C4), demandeur public prévenu d'une
 * modification (C5), scission d'une réservation commencée (C6), comptes du véhicule choisi (C9),
 * « réaffecter » exige un véhicule (D0), droit de gérer PAR véhicule (D1), réservation commencée
 * encore modifiable (C44).
 */
describe('ReservationsService — revue du 29/09', () => {
  const H = 3_600_000;
  const futur = (over: Record<string, unknown> = {}) =>
    evRow({ status: 'CONFIRMED', startAt: new Date(Date.now() + 48 * H), endAt: new Date(Date.now() + 50 * H), ...over });

  /** Vivier renvoyé par un `suggest` mocké. */
  const vivier = (ids: string[], over: Record<string, unknown> = {}) => ({
    startAt: '', endAt: '', excludedUnknownCapacity: 0, excludedImmobilized: 0, excludedDormant: 0,
    vehicles: ids.map((id) => ({ vehicleId: id, vehiclePlate: id.toUpperCase(), seats: 9, features: [], utilizationRatio: 0.1, underutilized: true })),
    ...over,
  });

  /** Un trajet simulé : `endedAt: null` = trajet EN COURS (le conducteur roule). */
  type Trajet = { vehicleId?: string; startedAt: Date; endedAt: Date | null };

  /**
   * Contre-revue du 29/09 (R0) — le mock de `trip.findFirst` ÉVALUE la vraie clause de
   * `hasTripOverlap` : `startedAt < fin`, puis trajet clos qui finit après le début (OR[0]) OU trajet
   * ouvert démarré depuis moins de 8 h avant le début (OR[1]), et le `NOT` des trajets propres à la
   * réservation. L'ancien mock ne lisait que OR[0] : la branche du trajet ouvert — la seule qui peut
   * tomber dans une fenêtre à venir — n'était jamais exercée, et un test figeait le faux positif.
   */
  function trouverTrajet(trajets: Trajet[], where: Record<string, unknown>): Trajet | undefined {
    const w = where as {
      vehicleId?: string;
      startedAt: { lt: Date };
      OR: [{ endedAt: { gt: Date } }, { endedAt: null; startedAt: { gt: Date } }];
      NOT?: { startedAt: { gte: Date } };
    };
    return trajets.find(
      (t) =>
        (!t.vehicleId || t.vehicleId === w.vehicleId) &&
        t.startedAt.getTime() < w.startedAt.lt.getTime() &&
        ((t.endedAt !== null && t.endedAt.getTime() > w.OR[0].endedAt.gt.getTime()) ||
          (t.endedAt === null && !!w.OR[1] && t.startedAt.getTime() > w.OR[1].startedAt.gt.getTime())) &&
        !(w.NOT && t.startedAt.getTime() >= w.NOT.startedAt.gte.getTime()),
    );
  }

  /**
   * Prisma aiguillé : `findMany` sur les réservations répond selon la requête — sœurs de la même
   * demande (filtre `metadata`), immobilisations (`blocksVehicle`), sinon conflits fermes. Un conflit
   * qui porte `startAt`/`endAt` n'est rendu que s'il chevauche la fenêtre demandée (R2 : une cible
   * prise mardi et libre jeudi) ; sans dates, il est toujours rendu.
   */
  function monter(opts: {
    row: Record<string, unknown>;
    soeurs?: { vehicleId: string }[];
    conflits?: unknown[];
    immobilises?: unknown[];
    /** Trajets du parc, évalués contre la vraie clause (cf. `trouverTrajet`). */
    trajets?: Trajet[];
    seats?: number | null;
    perms?: unknown;
    events?: unknown;
    emitter?: { emit: jest.Mock };
    childSeats?: unknown;
  }) {
    const update = jest.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      ...opts.row, ...args.data, vehicle: { plate: String(args.data['vehicleId'] ?? opts.row['vehicleId']).toUpperCase() },
    }));
    const create = jest.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      ...evRow(), id: 'r2', ...args.data, vehicle: { plate: String(args.data['vehicleId']).toUpperCase() },
    }));
    const prisma: Record<string, unknown> = makePrisma({
      vehicleEvent: {
        findUnique: jest.fn().mockResolvedValue(opts.row),
        findMany: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
          if (where?.['metadata']) return opts.soeurs ?? [];
          if (where?.['blocksVehicle']) return opts.immobilises ?? [];
          const w = where as { startAt?: { lt?: Date }; endAt?: { gt?: Date } };
          return (opts.conflits ?? []).filter((c) => {
            const { startAt, endAt } = c as { startAt?: Date; endAt?: Date };
            if (!startAt || !endAt) return true;
            return (!w.startAt?.lt || startAt < w.startAt.lt) && (!w.endAt?.gt || endAt > w.endAt.gt);
          });
        }),
        create,
        update,
      },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({
          outOfServiceReason: null, plate: 'X', seats: opts.seats ?? null, tracker: { id: 't1', lastSeenAt: new Date() },
        }),
      },
      trip: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
          trouverTrajet(opts.trajets ?? [], where) ? { id: 't-trouve' } : null,
        ),
      },
    }) as Record<string, unknown>;
    prisma['$transaction'] = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    const emitter = opts.emitter ?? { emit: jest.fn() };
    const svc = new ReservationsService(
      prisma as never, access('ALL'), (opts.events ?? makeEvents()) as never, (opts.perms ?? makePerms(true)) as never,
      emitter as never, undefined, opts.childSeats as never,
    );
    return { svc, prisma, update, create, emitter };
  }
  const modifie = (emitter: { emit: jest.Mock }) => emitter.emit.mock.calls.filter((c) => c[0] === 'reservation.modified');

  // ─── C0 — plancher de places en réaffectation automatique ───────────────────────────────────
  describe('C0 — le groupe ne passe pas sur une voiture trop petite', () => {
    it('demande publique sur un seul véhicule : min(seatsNeeded 8, places d’origine 9) = 8 — jamais écrit dans la metadata', async () => {
      const { svc, update } = monter({ row: futur({ metadata: { public: true, bookingRef: 'g1', seatsNeeded: 8 } }), seats: 9 });
      const suggest = jest.spyOn(svc, 'suggest').mockResolvedValue(vivier(['v2']) as never);
      await svc.reaffecter(makeUser(), 'r1', {});
      expect(suggest.mock.calls[0][1].criteria).toEqual({ minSeats: 8 });
      expect(update.mock.calls[0][0].data.metadata).toBeUndefined();
    });

    it('ligne d’une demande répartie (11 personnes, véhicule de 5) : la part de CE véhicule, 5', async () => {
      const { svc } = monter({ row: futur({ metadata: { public: true, bookingRef: 'g1', seatsNeeded: 11 } }), seats: 5 });
      const suggest = jest.spyOn(svc, 'suggest').mockResolvedValue(vivier(['v2']) as never);
      await svc.reaffecter(makeUser(), 'r1', {});
      expect(suggest.mock.calls[0][1].criteria).toEqual({ minSeats: 5 });
    });

    it('réservation interne sans places saisies : les places du véhicule d’origine ; `minSeats` saisi l’emporte', async () => {
      const a = monter({ row: futur({ metadata: { criteria: { childSeatsBaby: 1 } } }), seats: 5 });
      const s1 = jest.spyOn(a.svc, 'suggest').mockResolvedValue(vivier(['v2']) as never);
      await a.svc.reaffecter(makeUser(), 'r1', {});
      expect(s1.mock.calls[0][1].criteria).toEqual({ childSeatsBaby: 1, minSeats: 5 });

      const b = monter({ row: futur({ metadata: { public: true, seatsNeeded: 8, criteria: { minSeats: 3 } } }), seats: 9 });
      const s2 = jest.spyOn(b.svc, 'suggest').mockResolvedValue(vivier(['v2']) as never);
      await b.svc.reaffecter(makeUser(), 'r1', {});
      expect(s2.mock.calls[0][1].criteria).toEqual({ minSeats: 3 });
    });

    it('aucun remplaçant : le 409 dit le plancher et les véhicules écartés faute de places renseignées', async () => {
      const { svc } = monter({ row: futur({ metadata: { public: true, seatsNeeded: 8 } }), seats: 9 });
      jest.spyOn(svc, 'suggest').mockResolvedValue(vivier([], { excludedUnknownCapacity: 2 }) as never);
      await expect(svc.reaffecter(makeUser(), 'r1', {})).rejects.toThrow(/au moins 8 places.*2 écarté\(s\) faute de nombre de places/);
    });
  });

  // ─── C1 — une demande EN ATTENTE est contrôlée sur la cible ─────────────────────────────────
  describe('C1 — réaffecter une demande en attente', () => {
    const demande = (over: Record<string, unknown> = {}) => futur({ status: 'REQUESTED', ...over });

    it('cible déjà réservée fermement -> 409, rien n’est déplacé', async () => {
      const { svc, update } = monter({ row: demande(), conflits: [{ id: 'autre', vehicle: { plate: 'BB-2' } }] });
      await expect(svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2' })).rejects.toBeInstanceOf(ConflictException);
      expect(update).not.toHaveBeenCalled();
    });

    it('cible immobilisée ou qui roule sur le créneau -> 409', async () => {
      const immo = monter({
        row: demande(),
        immobilises: [{ vehicleId: 'v2', type: 'INCIDENT', startAt: new Date(Date.now() - H), endAt: null }],
      });
      await expect(immo.svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2' })).rejects.toThrow(/immobilisé/);
      expect(immo.update).not.toHaveBeenCalled();

      // La demande commence dans 1 h ; v2 roule depuis 30 min (trajet ouvert) : il ne sera pas rentré.
      const roule = monter({
        row: demande({ startAt: new Date(Date.now() + H), endAt: new Date(Date.now() + 3 * H) }),
        trajets: [{ vehicleId: 'v2', startedAt: new Date(Date.now() - H / 2), endedAt: null }],
      });
      await expect(roule.svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2' })).rejects.toThrow(/roule déjà/);
    });

    it('jamais sur le véhicule d’une autre ligne de la même demande : refus en explicite, véhicule sauté en auto', async () => {
      const row = demande({ metadata: { public: true, bookingRef: 'g1', seatsNeeded: 4 } });
      const explicite = monter({ row, soeurs: [{ vehicleId: 'v2' }], seats: 5 });
      await expect(explicite.svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2' })).rejects.toThrow(/même demande/);

      const auto = monter({ row, soeurs: [{ vehicleId: 'v2' }], seats: 5 });
      jest.spyOn(auto.svc, 'suggest').mockResolvedValue(vivier(['v1', 'v2', 'v3']) as never);
      await auto.svc.reaffecter(makeUser(), 'r1', {});
      expect(auto.update.mock.calls[0][0].data.vehicleId).toBe('v3');
    });

    it('cible libre -> déplacée (et une demande en attente ne prévient personne)', async () => {
      const { svc, update, emitter } = monter({ row: demande({ metadata: { public: true, requesterContact: 'a@b.fr' } }) });
      await svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2' });
      expect(update.mock.calls[0][0].data.vehicleId).toBe('v2');
      expect(modifie(emitter)).toHaveLength(0);
    });
  });

  // ─── C2 — le stock de sièges se lit sans la réservation qu'on déplace ───────────────────────
  it('C2 — en `auto`, la disponibilité des sièges exclut la réservation et ses sœurs ; le seul siège du stock lui revient', async () => {
    const childSeats = {
      // Stock de 1 bébé, rien d'engagé une fois la réservation elle-même exclue.
      availability: jest.fn().mockResolvedValue({
        startAt: '', endAt: '', policy: 'STOCK_OR_INSTALLED', total: { baby: 1, child: 0 }, installed: { baby: 0, child: 0 },
        stock: { baby: 1, child: 0 }, engaged: { baby: 0, child: 0 }, available: { baby: 1, child: 0 },
      }),
      assertAvailable: jest.fn().mockResolvedValue(undefined),
    };
    const { svc, prisma, update } = monter({
      row: futur({ metadata: { bookingRef: 'g1', criteria: { minSeats: 4, childSeatsBaby: 1 } } }),
      childSeats,
    });
    (prisma['vehicle'] as { findMany: jest.Mock }).findMany.mockResolvedValue([
      { id: 'v2', plate: 'BB-2', seats: 5, childSeatsBaby: 0, childSeatsChild: 0, features: [], tracker: null },
    ]);
    await svc.reaffecter(makeUser(), 'r1', {});
    expect(childSeats.availability).toHaveBeenCalledWith(
      'f1', expect.any(Date), expect.any(Date), expect.objectContaining({ excludeId: 'r1', excludeBookingRef: 'g1' }),
    );
    expect(update.mock.calls[0][0].data.vehicleId).toBe('v2');
  });

  // ─── C3 — « aucun groupe » explicite ────────────────────────────────────────────────────────
  describe('C3 — `group: null` = aucun groupe, absent = défaut', () => {
    const avecGroupes = () => {
      const m = monter({ row: evRow({ status: 'REQUESTED', metadata: { group: { id: 'g-nord', name: 'Nord' } } }) });
      const p = m.prisma as { vehicleGroupAssignment: { findFirst: jest.Mock }; vehicleEvent: { create: jest.Mock; findUnique: jest.Mock } };
      p.vehicleGroupAssignment.findFirst.mockResolvedValue({ group: { id: 'g-nord', name: 'Nord' } });
      return { ...m, p };
    };

    it('à la demande : `null` n’hérite PAS du groupe du véhicule ; absent, si', async () => {
      const { svc, create } = avecGroupes();
      await svc.request(makeUser(), { vehicleId: 'v1', ...SLOT, group: null });
      expect(create.mock.calls[0][0].data.metadata.group).toBeNull();
      await svc.request(makeUser(), { vehicleId: 'v1', ...SLOT });
      expect(create.mock.calls[1][0].data.metadata.group).toEqual({ id: 'g-nord', name: 'Nord' });
    });

    it('à la validation : `null` retire le groupe posé ; absent garde le « aucun » choisi au dépôt, sinon le véhicule', async () => {
      const { svc, update, p } = avecGroupes();
      await svc.confirm(makeUser(), 'r1', { group: null });
      expect(update.mock.calls[0][0].data.metadata.group).toBeNull();

      p.vehicleEvent.findUnique.mockResolvedValue(evRow({ status: 'REQUESTED', metadata: { group: null } }));
      await svc.confirm(makeUser(), 'r1', {});
      expect(update.mock.calls[1][0].data.metadata.group).toBeNull();

      p.vehicleEvent.findUnique.mockResolvedValue(evRow({ status: 'REQUESTED', metadata: { public: true } }));
      await svc.confirm(makeUser(), 'r1', {});
      expect(update.mock.calls[2][0].data.metadata.group).toEqual({ id: 'g-nord', name: 'Nord' });
    });
  });

  // ─── C4 — pas de changement de société à la validation non plus ─────────────────────────────
  it('C4 — valider en réaffectant sur un véhicule d’une autre société -> 400, rien n’est validé', async () => {
    const { svc, update } = monter({
      row: evRow({ status: 'REQUESTED' }),
      events: makeEvents({ assertVehicleAccess: jest.fn().mockResolvedValue('f2') }),
    });
    await expect(svc.confirm(makeUser({ role: UserRole.SUPER_ADMIN }), 'r1', { vehicleId: 'v9' })).rejects.toThrow(/autre société/);
    expect(update).not.toHaveBeenCalled();
  });

  it('C4 — réaffecter vers un véhicule d’une autre société -> 400', async () => {
    const { svc, update } = monter({
      row: futur(),
      events: makeEvents({ assertVehicleAccess: jest.fn().mockResolvedValue('f2') }),
    });
    await expect(svc.reaffecter(makeUser({ role: UserRole.SUPER_ADMIN }), 'r1', { versVehicleId: 'v9' })).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  // ─── C5 — le demandeur public apprend la modification, une seule fois ───────────────────────
  describe('C5 — `reservation.modified`', () => {
    const publique = (over: Record<string, unknown> = {}) =>
      futur({ metadata: { public: true, bookingRef: 'g1', requesterContact: 'ecole@test.fr', criteria: { minSeats: 4 } }, ...over });

    it('réaffecter une réservation publique CONFIRMÉE : un seul événement, avec la nouvelle plaque', async () => {
      const { svc, emitter } = monter({ row: publique() });
      await svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2' });
      expect(modifie(emitter)).toHaveLength(1);
      expect(modifie(emitter)[0][1]).toEqual(expect.objectContaining({ fleetId: 'f1', vehiclePlate: 'V2' }));
      expect(emitter.emit).not.toHaveBeenCalledWith('reservation.confirmed', expect.anything());
    });

    it('décaler le créneau le dit aussi ; renvoyer le même créneau ou changer le motif, non', async () => {
      const row = publique();
      const { svc, emitter, update } = monter({ row });
      await svc.update(makeUser(), 'r1', {
        startAt: new Date((row.startAt as Date).getTime() + H).toISOString(),
        endAt: new Date((row.endAt as Date).getTime() + H).toISOString(),
      });
      expect(modifie(emitter)).toHaveLength(1);

      await svc.update(makeUser(), 'r1', {
        startAt: (row.startAt as Date).toISOString(),
        endAt: (row.endAt as Date).toISOString(),
        reason: 'autre motif',
      });
      expect(modifie(emitter)).toHaveLength(1); // toujours un seul
      expect(update.mock.calls[1][0].data.startAt).toBeUndefined(); // rien de déplacé, rien de réécrit
    });

    it('réservation interne, demande en attente ou consignation rétroactive : personne à prévenir', async () => {
      const interne = monter({ row: futur({ metadata: { criteria: { minSeats: 4 } } }) });
      await interne.svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2' });
      expect(modifie(interne.emitter)).toHaveLength(0);

      const retro = monter({ row: publique({ metadata: { public: true, retroactive: true } }) });
      await retro.svc.update(makeUser(), 'r1', { vehicleId: 'v2' });
      expect(modifie(retro.emitter)).toHaveLength(0);
    });
  });

  // ─── C6 — scinder une réservation déjà commencée ────────────────────────────────────────────
  describe('C6 — la partie écoulée reste sur son véhicule', () => {
    const enCours = (over: Record<string, unknown> = {}) =>
      evRow({
        status: 'CONFIRMED', source: 'MANUAL', createdBy: 'u-auteur', title: 'Sortie scolaire',
        startAt: new Date(Date.now() - 4 * H), endAt: new Date(Date.now() + 4 * H),
        metadata: { criteria: { minSeats: 4 }, group: { id: 'g-nord', name: 'Nord' } },
        ...over,
      });

    it('auto : cherche un remplaçant sur [maintenant, fin), coupe l’origine et crée la suite, dans une transaction', async () => {
      const row = enCours();
      // v2 a roulé CE MATIN (trajet clos) : il ne doit plus être disqualifié pour la suite.
      const { svc, prisma, update, create } = monter({
        row,
        trajets: [{ vehicleId: 'v2', startedAt: new Date(Date.now() - 3 * H), endedAt: new Date(Date.now() - H) }],
      });
      const suggest = jest.spyOn(svc, 'suggest').mockResolvedValue(vivier(['v2']) as never);
      const coupe = new Date(Math.floor(Date.now() / 60_000) * 60_000);

      const dto = await svc.reaffecter(makeUser(), 'r1', {});

      expect(new Date(suggest.mock.calls[0][1].startAt).getTime()).toBeGreaterThanOrEqual(coupe.getTime());
      expect((prisma['$transaction'] as jest.Mock)).toHaveBeenCalledTimes(1);
      const original = update.mock.calls[0][0];
      expect(original.where).toEqual({ id: 'r1' });
      expect(original.data.vehicleId).toBeUndefined(); // le passé ne change pas de plaque
      expect((original.data.endAt as Date).getTime()).toBeGreaterThanOrEqual(coupe.getTime());
      const suite = create.mock.calls[0][0].data;
      expect(suite).toEqual(expect.objectContaining({
        vehicleId: 'v2', fleetId: 'f1', status: 'CONFIRMED', source: 'MANUAL', createdBy: 'u-auteur', title: 'Sortie scolaire', endAt: row.endAt,
      }));
      expect(suite.startAt).toEqual(original.data.endAt);
      expect(suite.metadata).toEqual(expect.objectContaining({ suiteDe: 'r1', group: { id: 'g-nord', name: 'Nord' } }));
      expect(dto.vehicleId).toBe('v2');
    });

    it('cible explicite : contrôlée sur la suite seulement (une réservation ferme sur la suite -> 409, rien n’est écrit)', async () => {
      const { svc, create, update } = monter({ row: enCours(), conflits: [{ id: 'x', vehicle: { plate: 'V2' } }] });
      await expect(svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2' })).rejects.toBeInstanceOf(ConflictException);
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('une demande EN ATTENTE déjà commencée se refuse, avec un message clair', async () => {
      const { svc, create, update } = monter({ row: enCours({ status: 'REQUESTED' }) });
      await expect(svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2' })).rejects.toThrow(/déjà commencé sans avoir été validée/);
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('changer le véhicule à l’édition scinde de la même façon', async () => {
      const { svc, create } = monter({ row: enCours() });
      await svc.update(makeUser(), 'r1', { vehicleId: 'v2' });
      expect(create.mock.calls[0][0].data).toEqual(expect.objectContaining({ vehicleId: 'v2', metadata: expect.objectContaining({ suiteDe: 'r1' }) }));
    });

    it('Réorganiser → réaffecter reprend la réservation en cours ; annuler ne la touche toujours pas', async () => {
      const liste = [{
        id: 'e1', vehicleId: 'v1', vehiclePlate: 'AA-1', type: 'RESERVATION', status: 'CONFIRMED', source: 'MANUAL',
        startAt: new Date(Date.now() - 2 * H).toISOString(), endAt: new Date(Date.now() + 2 * H).toISOString(),
      }];
      const svc = new ReservationsService(makePrisma(), access('ALL'), makeEvents({ list: jest.fn().mockResolvedValue(liste) }), makePerms(true));
      const fenetre = { from: new Date(Date.now() - 24 * H).toISOString(), to: new Date(Date.now() + 7 * 24 * H).toISOString() };
      const r = await svc.reorganiser(makeUser(), { ...fenetre, action: 'reaffecter', origine: 'toutes', vehicleId: 'v1' });
      expect(r.concernees).toBe(1);
      const a = await svc.reorganiser(makeUser(), { ...fenetre, action: 'annuler', origine: 'toutes', vehicleId: 'v1' });
      expect(a.concernees).toBe(0);
    });
  });

  // ─── C9 / D0 — réorganiser ──────────────────────────────────────────────────────────────────
  describe('C9 / D0 — réorganiser', () => {
    const resa = (over: Record<string, unknown> = {}) => ({
      id: 'e1', vehicleId: 'v1', vehiclePlate: 'AA-111-BB', type: 'RESERVATION', status: 'CONFIRMED', source: 'SYSTEM',
      startAt: new Date(Date.now() + 48 * H).toISOString(), endAt: new Date(Date.now() + 50 * H).toISOString(),
      ...over,
    });
    const fenetre = () => ({ from: new Date(Date.now() - 24 * H).toISOString(), to: new Date(Date.now() + 30 * 24 * H).toISOString() });
    const liste = () => [
      resa(), // agent, v1
      resa({ id: 'e2', vehicleId: 'v2', vehiclePlate: 'CC-3', source: 'MANUAL' }),
      resa({ id: 'e3', vehicleId: 'v2', vehiclePlate: 'CC-3', source: 'SYSTEM', metadata: { public: true } }),
    ];

    it('C9 — un véhicule choisi : `totauxVehicule` compte CE véhicule (l’écran ne dit plus « rien à venir sur X »)', async () => {
      const svc = new ReservationsService(makePrisma(), access('ALL'), makeEvents({ list: jest.fn().mockResolvedValue(liste()) }), makePerms(true));
      const r = await svc.reorganiser(makeUser(), { ...fenetre(), action: 'annuler', origine: 'auto', vehicleId: 'v2' });
      expect(r.concernees).toBe(0);
      expect(r.totaux).toEqual({ agent: 1, public: 1, manuelle: 1 });
      expect(r.totauxVehicule).toEqual({ agent: 0, public: 1, manuelle: 1 });

      const sans = await svc.reorganiser(makeUser(), { ...fenetre(), action: 'annuler', origine: 'auto' });
      expect(sans.totauxVehicule).toBeUndefined();
    });

    it('D0 — « réaffecter » sans véhicule à libérer est refusé, en simulation comme à l’application', async () => {
      const svc = new ReservationsService(makePrisma(), access('ALL'), makeEvents({ list: jest.fn().mockResolvedValue(liste()) }), makePerms(true));
      const reaffecter = jest.spyOn(svc, 'reaffecter');
      await expect(svc.reorganiser(makeUser(), { ...fenetre(), action: 'reaffecter', origine: 'toutes' })).rejects.toThrow('Choisissez le véhicule à libérer.');
      await expect(
        svc.reorganiser(makeUser(), { ...fenetre(), action: 'reaffecter', origine: 'toutes', simulation: false }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(reaffecter).not.toHaveBeenCalled();
    });
  });

  // ─── D1 — le droit de gérer se lit PAR véhicule ─────────────────────────────────────────────
  describe('D1 — reservations_manage sur l’origine ET sur la cible', () => {
    const perms = (gere: (vehicleId: string) => boolean) =>
      ({ canOnVehicle: jest.fn().mockImplementation(async (_u: unknown, v: string) => gere(v)), canGlobally: jest.fn().mockResolvedValue(true) });

    it('origine non gérée -> 403, rien n’est cherché ni écrit', async () => {
      const { svc, update } = monter({ row: futur(), perms: perms((v) => v !== 'v1') });
      const suggest = jest.spyOn(svc, 'suggest');
      await expect(svc.reaffecter(makeUser({ role: UserRole.FLEET_MANAGER }), 'r1', {})).rejects.toBeInstanceOf(ForbiddenException);
      expect(suggest).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('cible explicite non gérée -> 403', async () => {
      const { svc, update } = monter({ row: futur(), perms: perms((v) => v !== 'v2') });
      await expect(svc.reaffecter(makeUser({ role: UserRole.FLEET_MANAGER }), 'r1', { versVehicleId: 'v2' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(update).not.toHaveBeenCalled();
    });

    it('auto : le premier candidat que l’appelant GÈRE, pas le premier du vivier ; aucun -> 409 qui le dit', async () => {
      const ok = monter({ row: futur({ metadata: { criteria: { minSeats: 4 } } }), perms: perms((v) => v !== 'v2') });
      jest.spyOn(ok.svc, 'suggest').mockResolvedValue(vivier(['v2', 'v3']) as never);
      await ok.svc.reaffecter(makeUser({ role: UserRole.FLEET_MANAGER }), 'r1', {});
      expect(ok.update.mock.calls[0][0].data.vehicleId).toBe('v3');

      const aucun = monter({ row: futur({ metadata: { criteria: { minSeats: 4 } } }), perms: perms((v) => v === 'v1') });
      jest.spyOn(aucun.svc, 'suggest').mockResolvedValue(vivier(['v2', 'v3']) as never);
      await expect(aucun.svc.reaffecter(makeUser({ role: UserRole.FLEET_MANAGER }), 'r1', {})).rejects.toThrow(/2 véhicule\(s\) libre\(s\) dont vous ne gérez pas/);
    });

    /**
     * Contre-revue du 29/09 (R1) — la porte d'à côté. `reaffecter` refusait, mais la feuille d'édition
     * (PATCH) changeait la plaque avec le seul garde du contrôleur (union des droits) : un gestionnaire
     * de Nord, simple demandeur sur Sud, posait une réservation FERME sur Sud — et, depuis la scission,
     * une réservation commencée y créait sa suite ferme par le même chemin.
     */
    describe('R1 — la feuille d’édition et la validation exigent aussi de gérer l’origine ET la cible', () => {
      const gestionnaire = () => makeUser({ role: UserRole.FLEET_MANAGER });

      it('update : cible non gérée -> 403, rien n’est écrit', async () => {
        const { svc, update, create, prisma } = monter({ row: futur(), perms: perms((v) => v !== 'v2') });
        await expect(svc.update(gestionnaire(), 'r1', { vehicleId: 'v2' })).rejects.toThrow(
          'Vous ne gérez pas les réservations du véhicule visé : vous ne pouvez rien y poser.',
        );
        expect(update).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(prisma['$transaction']).not.toHaveBeenCalled();
      });

      it('update : origine non gérée -> 403 qui nomme la plaque', async () => {
        const { svc, update } = monter({ row: futur(), perms: perms((v) => v !== 'v1') });
        await expect(svc.update(gestionnaire(), 'r1', { vehicleId: 'v2' })).rejects.toThrow(
          /Vous ne gérez pas les réservations de AA-1 : vous ne pouvez pas les déplacer/,
        );
        expect(update).not.toHaveBeenCalled();
      });

      it('update d’une réservation COMMENCÉE vers une cible non gérée : 403 AVANT la scission', async () => {
        const row = evRow({ status: 'CONFIRMED', startAt: new Date(Date.now() - 2 * H), endAt: new Date(Date.now() + 2 * H) });
        const { svc, update, create, prisma } = monter({ row, perms: perms((v) => v !== 'v2') });
        await expect(svc.update(gestionnaire(), 'r1', { vehicleId: 'v2' })).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma['$transaction']).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
      });

      /**
       * Troisième relecture du 29/09 (T1) — ce test verrouillait le trou : « aucun droit par véhicule
       * demandé » pour décaler ou renommer. Un gestionnaire de Nord modifiait ainsi, une à une ou en
       * masse (« Réorganiser → Décaler »), n'importe quelle réservation de Sud. Inversé : dès qu'un
       * champ change, il faut gérer le véhicule ; un appel qui ne change rien n'a rien à prouver.
       */
      it('update sans changer de véhicule (créneau, motif) : 403 qui nomme la plaque, rien n’est écrit', async () => {
        const row = futur();
        const p = perms((v) => v !== 'v1');
        const { svc, update } = monter({ row, perms: p });
        await expect(svc.update(gestionnaire(), 'r1', { reason: 'autre motif' })).rejects.toThrow(
          'Vous ne gérez pas les réservations de AA-1 : vous ne pouvez pas les modifier.',
        );
        await expect(
          svc.update(gestionnaire(), 'r1', {
            startAt: new Date((row.startAt as Date).getTime() + H).toISOString(),
            endAt: new Date((row.endAt as Date).getTime() + H).toISOString(),
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(update).not.toHaveBeenCalled();

        // Rien ne change (le même créneau, renvoyé tel qu'affiché) : rien à prouver, rien d'écrit de neuf.
        p.canOnVehicle.mockClear();
        await svc.update(gestionnaire(), 'r1', { startAt: (row.startAt as Date).toISOString(), endAt: (row.endAt as Date).toISOString() });
        expect(p.canOnVehicle).not.toHaveBeenCalled();
      });

      it('T1 — valider SUR PLACE une demande d’un véhicule non géré -> 403, rien n’est validé ; géré -> validée', async () => {
        const ko = monter({ row: futur({ status: 'REQUESTED' }), perms: perms((v) => v !== 'v1') });
        await expect(ko.svc.confirm(gestionnaire(), 'r1', {})).rejects.toThrow(
          'Vous ne gérez pas les réservations de AA-1 : vous ne pouvez pas les valider.',
        );
        expect(ko.update).not.toHaveBeenCalled();
        expect(ko.emitter.emit).not.toHaveBeenCalled();

        const ok = monter({ row: futur({ status: 'REQUESTED' }), perms: perms(() => true) });
        await ok.svc.confirm(gestionnaire(), 'r1', {});
        expect(ok.update.mock.calls[0][0].data.status).toBe('CONFIRMED');
      });

      it('T1 — annuler une réservation d’un véhicule non géré -> 403, rien n’est écrit ni émis ; retirer SA demande reste permis', async () => {
        const ko = monter({ row: futur({ metadata: { public: true, requesterContact: 'a@b.fr' } }), perms: perms((v) => v !== 'v1') });
        await expect(ko.svc.cancel(gestionnaire(), 'r1')).rejects.toThrow(
          'Vous ne gérez pas les réservations de AA-1 : vous ne pouvez pas les annuler.',
        );
        expect(ko.update).not.toHaveBeenCalled();
        expect(ko.emitter.emit).not.toHaveBeenCalled();

        // Sa propre demande encore en attente (déposée sur Sud, où il ne peut que demander) : il la retire.
        const retrait = monter({ row: futur({ status: 'REQUESTED', metadata: { requesterId: 'u1' } }), perms: perms(() => false) });
        await retrait.svc.cancel(gestionnaire(), 'r1');
        expect(retrait.update.mock.calls[0][0].data.status).toBe('CANCELLED');
        // … mais pas celle d'un autre.
        const autre = monter({ row: futur({ status: 'REQUESTED', metadata: { requesterId: 'u-autre' } }), perms: perms(() => false) });
        await expect(autre.svc.cancel(gestionnaire(), 'r1')).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('T1 — « Réorganiser » sur un véhicule non géré : annuler et décaler refusent chaque ligne, avec son motif', async () => {
        const rows = [futur({ id: 'a' }), futur({ id: 'b', startAt: new Date(Date.now() + 52 * H), endAt: new Date(Date.now() + 54 * H) })];
        const parId = new Map(rows.map((r) => [r['id'] as string, r]));
        const update = jest.fn();
        const prisma = makePrisma({
          vehicleEvent: {
            findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => parId.get(where.id) ?? null),
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn(),
            update,
          },
        });
        const dtos = rows.map((r) => ({
          id: r['id'], vehicleId: 'v1', vehiclePlate: 'AA-1', type: 'RESERVATION', status: 'CONFIRMED', source: 'MANUAL',
          startAt: (r['startAt'] as Date).toISOString(), endAt: (r['endAt'] as Date).toISOString(), metadata: null,
        }));
        const svc = new ReservationsService(
          prisma, access('ALL'), makeEvents({ list: jest.fn().mockResolvedValue(dtos) }), perms((v) => v !== 'v1') as never,
          { emit: jest.fn() } as never,
        );
        const fenetre = { from: new Date(Date.now() - H).toISOString(), to: new Date(Date.now() + 7 * 24 * H).toISOString() };
        for (const geste of [{ action: 'annuler' as const }, { action: 'decaler' as const, decalageMinutes: 30 }]) {
          const res = await svc.reorganiser(gestionnaire(), { ...fenetre, ...geste, origine: 'toutes', vehicleId: 'v1', simulation: false });
          expect(res.appliquees).toBe(0);
          expect(res.refusees).toHaveLength(2);
          for (const r of res.refusees) expect(r.motif).toMatch(/Vous ne gérez pas les réservations de AA-1/);
        }
        expect(update).not.toHaveBeenCalled();
      });

      it('confirm en réaffectant vers une cible non gérée -> 403, rien n’est validé', async () => {
        const { svc, update } = monter({ row: futur({ status: 'REQUESTED' }), perms: perms((v) => v !== 'v2') });
        await expect(svc.confirm(gestionnaire(), 'r1', { vehicleId: 'v2' })).rejects.toBeInstanceOf(ForbiddenException);
        expect(update).not.toHaveBeenCalled();
      });

      it('les deux gérés : la feuille d’édition déplace', async () => {
        const { svc, update } = monter({ row: futur(), perms: perms(() => true) });
        await svc.update(gestionnaire(), 'r1', { vehicleId: 'v2' });
        expect(update.mock.calls[0][0].data.vehicleId).toBe('v2');
      });
    });
  });

  // ─── R2 — la coupe au début de l'indisponibilité, pas à « maintenant » ──────────────────────
  describe('R2 — réaffecter à partir d’un moment (`aPartirDe`)', () => {
    const minute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000);
    /** Location commencée « lundi » (il y a 4 h), rendue « vendredi » (dans 96 h). */
    const lundiVendredi = (over: Record<string, unknown> = {}) =>
      evRow({
        status: 'CONFIRMED', source: 'MANUAL', startAt: new Date(Date.now() - 4 * H), endAt: new Date(Date.now() + 96 * H),
        metadata: { criteria: { minSeats: 4 } }, ...over,
      });
    const jeudi = () => new Date(Date.now() + 72 * H);

    it('commencée, maintenance jeudi : garde son véhicule jusqu’à jeudi, la suite part jeudi (auto cherché sur [jeudi, fin))', async () => {
      const row = lundiVendredi();
      const { svc, update, create } = monter({ row });
      const suggest = jest.spyOn(svc, 'suggest').mockResolvedValue(vivier(['v2']) as never);
      const aPartirDe = jeudi();
      await svc.reaffecter(makeUser(), 'r1', { aPartirDe: aPartirDe.toISOString() });
      const coupe = minute(aPartirDe);
      expect(new Date(suggest.mock.calls[0][1].startAt)).toEqual(coupe);
      expect(update.mock.calls[0][0].data.endAt).toEqual(coupe); // l'origine garde lundi → jeudi
      expect(create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ vehicleId: 'v2', startAt: coupe, endAt: row.endAt, status: 'CONFIRMED' }),
      );
    });

    it('cible prise MARDI mais libre à partir de jeudi : acceptée ; prise vendredi : 409, rien n’est écrit', async () => {
      const mardi = { id: 'mardi', vehicle: { plate: 'V2' }, startAt: new Date(Date.now() + 24 * H), endAt: new Date(Date.now() + 26 * H) };
      const ok = monter({ row: lundiVendredi(), conflits: [mardi] });
      await ok.svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2', aPartirDe: jeudi().toISOString() });
      expect(ok.create).toHaveBeenCalledTimes(1);

      const vendredi = { ...mardi, id: 'vendredi', startAt: new Date(Date.now() + 90 * H), endAt: new Date(Date.now() + 92 * H) };
      const ko = monter({ row: lundiVendredi(), conflits: [vendredi] });
      await expect(ko.svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2', aPartirDe: jeudi().toISOString() })).rejects.toBeInstanceOf(ConflictException);
      expect(ko.create).not.toHaveBeenCalled();
      expect(ko.update).not.toHaveBeenCalled();
    });

    it('pas encore commencée mais qui déborde sur l’indisponibilité : scindée aussi (la partie d’avant reste)', async () => {
      const row = lundiVendredi({ startAt: new Date(Date.now() + 24 * H) });
      const { svc, update, create } = monter({ row });
      const j = jeudi();
      await svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2', aPartirDe: j.toISOString() });
      expect(update.mock.calls[0][0].data.endAt).toEqual(minute(j));
      expect(create.mock.calls[0][0].data.startAt).toEqual(minute(j));
    });

    it('commence après l’indisponibilité : part EN ENTIER (aucune scission)', async () => {
      const row = lundiVendredi({ startAt: new Date(Date.now() + 80 * H) });
      const { svc, update, create } = monter({ row });
      await svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2', aPartirDe: jeudi().toISOString() });
      expect(create).not.toHaveBeenCalled();
      expect(update.mock.calls[0][0].data.vehicleId).toBe('v2');
    });

    it('finit avant l’indisponibilité : 400, rien n’est écrit', async () => {
      const row = lundiVendredi({ endAt: new Date(Date.now() + 10 * H) });
      const { svc, update, create } = monter({ row });
      await expect(svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2', aPartirDe: jeudi().toISOString() })).rejects.toThrow(
        /se termine avant que le véhicule ne devienne indisponible/,
      );
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('une demande EN ATTENTE qui déborde sur l’indisponibilité : refusée (jamais de suite CONFIRMÉE sans validation)', async () => {
      const row = lundiVendredi({ status: 'REQUESTED', startAt: new Date(Date.now() + 24 * H) });
      const { svc, update, create } = monter({ row });
      await expect(svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2', aPartirDe: jeudi().toISOString() })).rejects.toThrow(
        /validez-la ou refusez-la/,
      );
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('`aPartirDe` illisible : 400 ; dans le passé : la coupe reste « maintenant »', async () => {
      const enCours = evRow({ status: 'CONFIRMED', startAt: new Date(Date.now() - 4 * H), endAt: new Date(Date.now() + 4 * H) });
      const a = monter({ row: enCours });
      await expect(a.svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2', aPartirDe: 'jeudi' })).rejects.toBeInstanceOf(BadRequestException);

      const b = monter({ row: enCours });
      const avant = minute(new Date());
      await b.svc.reaffecter(makeUser(), 'r1', { versVehicleId: 'v2', aPartirDe: new Date(Date.now() - 48 * H).toISOString() });
      const coupe = b.create.mock.calls[0][0].data.startAt as Date;
      expect(coupe.getTime()).toBeGreaterThanOrEqual(avant.getTime());
      expect(coupe.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  // ─── R2 / attendu — réorganiser ─────────────────────────────────────────────────────────────
  describe('R2 — réorganiser : le lot « réaffecter » chevauche la fenêtre, la coupe est son début', () => {
    const r = (over: Record<string, unknown>) => ({
      id: 'e1', vehicleId: 'v1', vehiclePlate: 'AA-1', type: 'RESERVATION', status: 'CONFIRMED', source: 'MANUAL',
      startAt: new Date(Date.now() + 80 * H).toISOString(), endAt: new Date(Date.now() + 82 * H).toISOString(),
      ...over,
    });
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    const liste = () => [
      r({ id: 'lundi-vendredi', startAt: iso(-4 * H), endAt: iso(96 * H) }), // en cours, chevauche jeudi
      r({ id: 'vendredi' }), // commence dans la fenêtre
      r({ id: 'finie-avant', startAt: iso(H), endAt: iso(2 * H) }), // finit avant jeudi : pas concernée
      r({ id: 'panne', vehicleId: 'v3', vehiclePlate: 'CC-3', startAt: iso(-2 * H), endAt: iso(50 * H) }), // seule résa de v3, en cours
      r({ id: 'annulee', status: 'CANCELLED', startAt: iso(-2 * H), endAt: iso(90 * H) }),
    ];
    const fenetre = () => ({ from: iso(48 * H), to: iso(120 * H) });
    const monterReorg = (l: unknown[] = liste()) => {
      const list = jest.fn().mockResolvedValue(l);
      const svc = new ReservationsService(makePrisma(), access('ALL'), makeEvents({ list }), makePerms(true), { emit: jest.fn() } as never);
      return { svc, list };
    };

    it('« réaffecter » prend aussi la réservation commencée AVANT la fenêtre ; « annuler » seulement ce qui y commence', async () => {
      const { svc } = monterReorg();
      const reaf = await svc.reorganiser(makeUser(), { ...fenetre(), action: 'reaffecter', origine: 'toutes', vehicleId: 'v1' });
      expect(reaf.concernees).toBe(2); // lundi-vendredi + vendredi
      const ann = await svc.reorganiser(makeUser(), { ...fenetre(), action: 'annuler', origine: 'toutes', vehicleId: 'v1' });
      expect(ann.concernees).toBe(1); // vendredi seulement
    });

    it('`parVehicule` compte ce qui CHEVAUCHE la fenêtre, quelle que soit l’action : le véhicule en panne en pleine réservation y figure', async () => {
      const { svc } = monterReorg();
      const attendu = [
        { vehicleId: 'v1', plate: 'AA-1', n: 2 },
        { vehicleId: 'v3', plate: 'CC-3', n: 1 },
      ];
      const ann = await svc.reorganiser(makeUser(), { ...fenetre(), action: 'annuler', origine: 'toutes' });
      expect(ann.parVehicule).toEqual(attendu);
      const reaf = await svc.reorganiser(makeUser(), { ...fenetre(), action: 'reaffecter', origine: 'toutes', vehicleId: 'v3' });
      expect(reaf.parVehicule).toEqual(attendu);
      expect(reaf.concernees).toBe(1);
    });

    it('à l’application, chaque réservation est réaffectée À PARTIR du début de la fenêtre, en silence', async () => {
      const { svc } = monterReorg();
      const reaffecter = jest.spyOn(svc, 'reaffecter').mockResolvedValue({} as never);
      const f = fenetre();
      const res = await svc.reorganiser(makeUser(), { ...f, action: 'reaffecter', origine: 'toutes', vehicleId: 'v1', simulation: false });
      expect(res.appliquees).toBe(2);
      expect(reaffecter.mock.calls.map((c) => c[1])).toEqual(['lundi-vendredi', 'vendredi']);
      for (const c of reaffecter.mock.calls) {
        expect(c[2]).toEqual({ versVehicleId: 'auto', aPartirDe: f.from });
        expect(c[3]).toEqual({ silencieux: true });
      }
    });

    it('une demande jamais validée déjà commencée est DANS le lot : elle revient en refus nommé, pas en silence', async () => {
      const { svc } = monterReorg([r({ id: 'demande', status: 'REQUESTED', startAt: iso(-H), endAt: iso(60 * H) })]);
      const sim = await svc.reorganiser(makeUser(), { ...fenetre(), action: 'reaffecter', origine: 'toutes', vehicleId: 'v1' });
      expect(sim.concernees).toBe(1);
      // T4 (troisième relecture) : le refus est nommé DÈS la simulation, et l'aperçu dit « demande ».
      expect(sim.refusees).toEqual([expect.objectContaining({ plate: 'AA-1', motif: expect.stringMatching(/déjà commencé sans avoir été validée/) })]);
      expect(sim.apercu[0].status).toBe('REQUESTED');
      jest.spyOn(svc, 'reaffecter').mockRejectedValue(
        new BadRequestException('Cette demande a déjà commencé sans avoir été validée : validez-la ou refusez-la, elle ne se réaffecte pas.'),
      );
      const res = await svc.reorganiser(makeUser(), { ...fenetre(), action: 'reaffecter', origine: 'toutes', vehicleId: 'v1', simulation: false });
      expect(res.refusees).toEqual([expect.objectContaining({ plate: 'AA-1', motif: expect.stringMatching(/validez-la ou refusez-la/) })]);
    });

    it('`attendu` : le lot recalculé n’a plus le nombre annoncé -> 409, rien n’est écrit ; le bon nombre -> appliqué ; absent -> appliqué', async () => {
      const futurA = r({ id: 'a' });
      const futurB = r({ id: 'b', startAt: iso(84 * H), endAt: iso(86 * H) });
      const { svc, list } = monterReorg([futurA, futurB]);
      const cancel = jest.spyOn(svc, 'cancel').mockResolvedValue({} as never);
      const corps = { ...fenetre(), action: 'annuler' as const, origine: 'toutes' as const, vehicleId: 'v1' };
      const sim = await svc.reorganiser(makeUser(), corps);
      expect(sim.concernees).toBe(2);

      // Entre la simulation et le clic, une demande arrive par le lien public.
      list.mockResolvedValue([futurA, futurB, r({ id: 'arrivee', status: 'REQUESTED', source: 'SYSTEM', metadata: { public: true } })]);
      await expect(svc.reorganiser(makeUser(), { ...corps, simulation: false, attendu: sim.concernees })).rejects.toThrow(
        'La liste a changé depuis la simulation : relancez-la.',
      );
      await expect(svc.reorganiser(makeUser(), { ...corps, simulation: false, attendu: sim.concernees })).rejects.toBeInstanceOf(ConflictException);
      expect(cancel).not.toHaveBeenCalled();

      const ok = await svc.reorganiser(makeUser(), { ...corps, simulation: false, attendu: 3 });
      expect(ok.appliquees).toBe(3);
      const sans = await svc.reorganiser(makeUser(), { ...corps, simulation: false });
      expect(sans.appliquees).toBe(3);
    });
  });

  // ─── R3 — un seul courriel « modifiée » par demande groupée ─────────────────────────────────
  describe('R3 — réorganiser prévient UNE fois par demande (bookingRef), sur l’état final', () => {
    const debut = () => new Date(Date.now() + 48 * H);
    const ligne = (id: string, vehicleId: string, over: Record<string, unknown> = {}) =>
      evRow({
        id, vehicleId, vehicle: { plate: vehicleId.toUpperCase() }, status: 'CONFIRMED', source: 'SYSTEM',
        startAt: debut(), endAt: new Date(debut().getTime() + 2 * H),
        metadata: { public: true, bookingRef: 'g1', requesterContact: 'ecole@test.fr' },
        ...over,
      });
    function monterLot(rows: Record<string, unknown>[]) {
      const parId = new Map(rows.map((row) => [row['id'] as string, row]));
      const prisma = makePrisma({
        vehicleEvent: {
          findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => parId.get(where.id) ?? null),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
          update: jest.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
            ...parId.get(where.id), ...data,
          })),
        },
      });
      const dtos = rows.map((row) => ({
        id: row['id'], vehicleId: row['vehicleId'], vehiclePlate: (row['vehicle'] as { plate: string }).plate, type: 'RESERVATION',
        status: row['status'], source: row['source'], startAt: (row['startAt'] as Date).toISOString(),
        endAt: (row['endAt'] as Date).toISOString(), metadata: row['metadata'],
      }));
      const emitter = { emit: jest.fn() };
      const svc = new ReservationsService(
        prisma, access('ALL'), makeEvents({ list: jest.fn().mockResolvedValue(dtos) }), makePerms(true), emitter as never,
      );
      return { svc, emitter };
    }
    const decaler = { from: new Date(Date.now() - H).toISOString(), to: new Date(Date.now() + 7 * 24 * H).toISOString(), action: 'decaler' as const, decalageMinutes: 30, origine: 'toutes' as const, simulation: false };

    it('deux lignes CONFIRMÉES du même bookingRef décalées ensemble : UN événement, émis après les deux écritures', async () => {
      const { svc, emitter } = monterLot([ligne('a', 'v1'), ligne('b', 'v2')]);
      const res = await svc.reorganiser(makeUser(), decaler);
      expect(res.appliquees).toBe(2);
      expect(modifie(emitter)).toHaveLength(1);
      // La dernière ligne écrite porte le courriel de toute la demande.
      expect(modifie(emitter)[0][1]).toEqual(expect.objectContaining({ vehiclePlate: 'V2', status: 'CONFIRMED' }));
    });

    it('deux demandes différentes : un événement chacune ; une réservation publique sans bookingRef : la sienne', async () => {
      const { svc, emitter } = monterLot([
        ligne('a', 'v1'),
        ligne('b', 'v2', { metadata: { public: true, bookingRef: 'g2', requesterContact: 'autre@test.fr' } }),
        ligne('c', 'v3', { metadata: { public: true, requesterContact: 'seul@test.fr' } }),
      ]);
      await svc.reorganiser(makeUser(), decaler);
      expect(modifie(emitter)).toHaveLength(3);
    });

    it('seule une ligne DÉJÀ CONFIRMÉE avant le geste prévient (une demande en attente ou interne, non)', async () => {
      const { svc, emitter } = monterLot([
        ligne('a', 'v1', { status: 'REQUESTED' }),
        ligne('b', 'v2', { metadata: { bookingRef: 'interne' } }),
      ]);
      await svc.reorganiser(makeUser(), decaler);
      expect(modifie(emitter)).toHaveLength(0);
    });

    it('une édition unitaire (hors lot) prévient toujours, une fois', async () => {
      const { svc, emitter } = monterLot([ligne('a', 'v1')]);
      await svc.update(makeUser(), 'a', {
        startAt: new Date(debut().getTime() + H).toISOString(),
        endAt: new Date(debut().getTime() + 3 * H).toISOString(),
      });
      expect(modifie(emitter)).toHaveLength(1);
    });
  });

  // ─── R4 — rien pour une réservation terminée ────────────────────────────────────────────────
  describe('R4 — aucun courriel pour une réservation terminée, close ou annulée', () => {
    const publique = { public: true, bookingRef: 'g1', requesterContact: 'ecole@test.fr' };

    it('corriger après coup le véhicule d’une sortie d’HIER (toujours CONFIRMED) : écrit, personne n’est prévenu', async () => {
      const row = evRow({ status: 'CONFIRMED', startAt: new Date(Date.now() - 26 * H), endAt: new Date(Date.now() - 23 * H), metadata: publique });
      const { svc, update, emitter } = monter({ row });
      await svc.update(makeUser(), 'r1', { vehicleId: 'v2' });
      expect(update.mock.calls[0][0].data.vehicleId).toBe('v2');
      expect(modifie(emitter)).toHaveLength(0);
    });

    it('réservation annulée ou close dont on touche le créneau : personne n’est prévenu', async () => {
      for (const status of ['CANCELLED', 'DONE']) {
        const row = futur({ status, metadata: publique });
        const { svc, emitter } = monter({ row });
        await svc.update(makeUser(), 'r1', {
          startAt: new Date((row.startAt as Date).getTime() + H).toISOString(),
          endAt: new Date((row.endAt as Date).getTime() + H).toISOString(),
        });
        expect(modifie(emitter)).toHaveLength(0);
      }
    });
  });

  // ─── C44 — une réservation commencée reste modifiable ───────────────────────────────────────
  describe('C44 — prolonger une réservation déjà commencée', () => {
    const commencee = () =>
      evRow({ status: 'CONFIRMED', startAt: new Date(Date.now() - 24 * H), endAt: new Date(Date.now() + 24 * H), metadata: { reason: 'x' } });

    it('début renvoyé à l’identique + fin repoussée : accepté, même si le véhicule a roulé depuis le début de la réservation', async () => {
      const row = commencee();
      // Trajet d'hier, pendant CETTE réservation : c'est son usage, pas un conflit.
      const { svc, update } = monter({
        row,
        trajets: [{ vehicleId: 'v1', startedAt: new Date(Date.now() - 20 * H), endedAt: new Date(Date.now() - 19 * H) }],
      });
      const nouvelleFin = new Date((row.endAt as Date).getTime() + 24 * H);
      await svc.update(makeUser(), 'r1', { startAt: (row.startAt as Date).toISOString(), endAt: nouvelleFin.toISOString() });
      const data = update.mock.calls[0][0].data;
      expect(data.startAt).toBeUndefined();
      expect(data.endAt).toEqual(nouvelleFin);
    });

    /**
     * Contre-revue du 29/09 (R0) — le cas « prolonger » le plus fréquent : le conducteur appelle de la
     * route. La fenêtre contrôlée est à venir, donc seul un trajet OUVERT peut y tomber — et c'était
     * celui de la réservation elle-même, qui répondait 409 « roule déjà ».
     */
    describe('R0 — le trajet en cours de la réservation n’est pas un conflit', () => {
      const bientotFinie = (debutIlYa: number, finDans: number) =>
        evRow({
          status: 'CONFIRMED', startAt: new Date(Date.now() - debutIlYa), endAt: new Date(Date.now() + finDans), metadata: { reason: 'x' },
        });

      it('(a) fin dans 30 min, conducteur parti il y a 45 min (après le début de la réservation) : +2 h acceptées', async () => {
        const row = bientotFinie(24 * H, H / 2);
        const { svc, update } = monter({
          row,
          trajets: [{ vehicleId: 'v1', startedAt: new Date(Date.now() - 0.75 * H), endedAt: null }],
        });
        const nouvelleFin = new Date((row.endAt as Date).getTime() + 2 * H);
        await svc.update(makeUser(), 'r1', { endAt: nouvelleFin.toISOString() });
        expect(update.mock.calls[0][0].data.endAt).toEqual(nouvelleFin);
      });

      it('(b) le trajet ouvert a commencé AVANT la réservation (quelqu’un d’autre au volant) : 409, rien n’est écrit', async () => {
        const row = bientotFinie(2 * H, H / 2);
        const { svc, update } = monter({
          row,
          trajets: [{ vehicleId: 'v1', startedAt: new Date(Date.now() - 3 * H), endedAt: null }],
        });
        await expect(
          svc.update(makeUser(), 'r1', { endAt: new Date((row.endAt as Date).getTime() + 2 * H).toISOString() }),
        ).rejects.toThrow(/roule déjà/);
        expect(update).not.toHaveBeenCalled();
      });

      it('(c) réservation déjà en retard (fin il y a 1 h, conducteur encore dehors depuis 3 h) : prolongée jusqu’à dans 2 h', async () => {
        const row = evRow({
          status: 'CONFIRMED', startAt: new Date(Date.now() - 5 * H), endAt: new Date(Date.now() - H), metadata: { reason: 'x' },
        });
        const { svc, update } = monter({
          row,
          trajets: [{ vehicleId: 'v1', startedAt: new Date(Date.now() - 3 * H), endedAt: null }],
        });
        const nouvelleFin = new Date(Date.now() + 2 * H);
        await svc.update(makeUser(), 'r1', { endAt: nouvelleFin.toISOString() });
        expect(update.mock.calls[0][0].data.endAt).toEqual(nouvelleFin);
      });

      it('sur un AUTRE véhicule, tout trajet compte : la cible qui roule refuse la suite, même démarrée pendant la réservation', async () => {
        const row = bientotFinie(2 * H, 2 * H);
        const { svc, create } = monter({
          row,
          trajets: [{ vehicleId: 'v2', startedAt: new Date(Date.now() - H), endedAt: null }],
        });
        await expect(svc.update(makeUser(), 'r1', { vehicleId: 'v2' })).rejects.toThrow(/roule déjà/);
        expect(create).not.toHaveBeenCalled();
      });

      it('la clause envoyée à Prisma écarte les trajets démarrés depuis le début de la réservation (même véhicule seulement)', async () => {
        const row = bientotFinie(24 * H, H / 2);
        const { svc, prisma } = monter({ row });
        await svc.update(makeUser(), 'r1', { endAt: new Date((row.endAt as Date).getTime() + 2 * H).toISOString() });
        const where = (prisma['trip'] as { findFirst: jest.Mock }).findFirst.mock.calls[0][0].where;
        expect(where.NOT).toEqual({ startedAt: { gte: row.startAt } });
      });
    });

    it('changer seulement le groupe d’une réservation commencée : accepté', async () => {
      const { svc, update } = monter({ row: commencee() });
      await svc.update(makeUser(), 'r1', { group: null });
      expect(update.mock.calls[0][0].data.metadata.group).toBeNull();
    });

    it('un début déplacé dans le passé reste refusé ; une nouvelle fin déjà passée aussi', async () => {
      const row = commencee();
      const { svc, update } = monter({ row });
      await expect(
        svc.update(makeUser(), 'r1', { startAt: new Date((row.startAt as Date).getTime() - H).toISOString() }),
      ).rejects.toThrow(/dans le passé/);
      await expect(
        svc.update(makeUser(), 'r1', { endAt: new Date(Date.now() - H).toISOString() }),
      ).rejects.toThrow(/fin est déjà passée/);
      expect(update).not.toHaveBeenCalled();
    });

    /**
     * Contre-revue (R0) : ce test simulait un trajet CLOS qui se terminait dans 100 h — impossible en
     * production, et il figeait en fait le faux positif. La partie ajoutée reste contrôlée : ce qui
     * peut réellement y tomber, c'est une immobilisation déclarée sur les heures ajoutées.
     */
    it('la prolongation se contrôle sur la partie AJOUTÉE : une immobilisation sur les heures ajoutées -> 409', async () => {
      const row = commencee();
      const { svc, update } = monter({
        row,
        immobilises: [{ vehicleId: 'v1', type: 'INCIDENT', startAt: new Date((row.endAt as Date).getTime() + H), endAt: null }],
      });
      await expect(
        svc.update(makeUser(), 'r1', { endAt: new Date((row.endAt as Date).getTime() + 24 * H).toISOString() }),
      ).rejects.toThrow(/immobilisé/);
      expect(update).not.toHaveBeenCalled();
    });
  });

  // ─── Troisième relecture du 29/09 ───────────────────────────────────────────────────────────
  describe('Troisième relecture du 29/09 — T0, T2, T3, T4, T13', () => {
    /**
     * Un parc EN MÉMOIRE : `update` déplace vraiment la ligne, et le contrôle de conflit ferme
     * (`findOverlaps`) relit l'état COURANT — c'est ce qui rend l'ordre d'écriture observable (T0).
     * `events.list` rend le parc trié par début croissant, comme la vraie requête.
     */
    function monterParc(rows: Record<string, unknown>[]) {
      const parc = new Map(rows.map((r) => [r['id'] as string, { ...r }]));
      const update = jest.fn().mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const ligne = { ...parc.get(where.id)!, ...data };
        parc.set(where.id, ligne);
        return ligne;
      });
      const findMany = jest.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
        if (where?.['metadata'] || where?.['blocksVehicle']) return [];
        const w = where as { vehicleId?: string; status?: { in?: string[] }; startAt?: { lt?: Date }; endAt?: { gt?: Date }; id?: { not?: string } };
        return [...parc.values()].filter(
          (r) =>
            r['vehicleId'] === w.vehicleId &&
            (!w.status?.in || w.status.in.includes(r['status'] as string)) &&
            (!w.startAt?.lt || (r['startAt'] as Date) < w.startAt.lt) &&
            (!w.endAt?.gt || (r['endAt'] as Date) > w.endAt.gt) &&
            (!w.id?.not || r['id'] !== w.id.not),
        );
      });
      const prisma = makePrisma({
        vehicleEvent: {
          findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => parc.get(where.id) ?? null),
          findMany,
          create: jest.fn(),
          update,
        },
      });
      const list = jest.fn().mockImplementation(async () =>
        [...parc.values()]
          .sort((a, b) => (a['startAt'] as Date).getTime() - (b['startAt'] as Date).getTime())
          .map((r) => ({
            id: r['id'], fleetId: r['fleetId'], vehicleId: r['vehicleId'],
            vehiclePlate: (r['vehicle'] as { plate: string } | undefined)?.plate ?? null,
            type: 'RESERVATION', status: r['status'], source: r['source'], title: r['title'],
            startAt: (r['startAt'] as Date).toISOString(), endAt: (r['endAt'] as Date).toISOString(), metadata: r['metadata'] ?? null,
          })),
      );
      const emitter = { emit: jest.fn() };
      const svc = new ReservationsService(prisma, access('ALL'), makeEvents({ list }), makePerms(true), emitter as never);
      return { svc, parc, update, emitter };
    }
    /** Dans trois jours, à h:m (UTC) — toujours à venir. */
    const jour = (h: number, m = 0) => {
      const d = new Date(Date.now() + 3 * 24 * H);
      d.setUTCHours(h, m, 0, 0);
      return d;
    };
    const ferme = (id: string, debut: Date, fin: Date, over: Record<string, unknown> = {}) =>
      evRow({ id, status: 'CONFIRMED', startAt: debut, endAt: fin, ...over });
    const semaine = () => ({ from: new Date(Date.now() - H).toISOString(), to: new Date(Date.now() + 7 * 24 * H).toISOString() });
    const emis = (emitter: { emit: jest.Mock }, nom: string) => emitter.emit.mock.calls.filter((c) => c[0] === nom);

    // ─── T0 — l'ordre d'écriture d'un décalage ────────────────────────────────────────────────
    it('T0 — décaler de +90 deux réservations fermes COLLÉES du même véhicule : la plus tardive part d’abord, les deux passent', async () => {
      const { svc, parc, update } = monterParc([ferme('r1', jour(8), jour(12)), ferme('r2', jour(12), jour(16))]);
      const res = await svc.reorganiser(makeUser(), {
        ...semaine(), action: 'decaler', decalageMinutes: 90, origine: 'toutes', simulation: false, attendu: 2,
      });
      expect(res.refusees).toEqual([]);
      expect(res.appliquees).toBe(2);
      expect(update.mock.calls.map((c) => c[0].where.id)).toEqual(['r2', 'r1']);
      expect(parc.get('r1')!['startAt']).toEqual(jour(9, 30));
      expect(parc.get('r2')!['endAt']).toEqual(jour(17, 30));
      // L'aperçu garde l'ordre du lot : seule l'écriture change d'ordre.
      expect(res.apercu.map((a) => a.startAt)).toEqual([jour(8).toISOString(), jour(12).toISOString()]);
    });

    it('T0 — décaler de −90 : la plus tôt part d’abord, les deux passent', async () => {
      const { svc, parc, update } = monterParc([ferme('r1', jour(8), jour(12)), ferme('r2', jour(12), jour(16))]);
      const res = await svc.reorganiser(makeUser(), {
        ...semaine(), action: 'decaler', decalageMinutes: -90, origine: 'toutes', simulation: false, attendu: 2,
      });
      expect(res.refusees).toEqual([]);
      expect(res.appliquees).toBe(2);
      expect(update.mock.calls.map((c) => c[0].where.id)).toEqual(['r1', 'r2']);
      expect(parc.get('r1')!['startAt']).toEqual(jour(6, 30));
      expect(parc.get('r2')!['startAt']).toEqual(jour(10, 30));
    });

    it('T0 — un vrai conflit (réservation ferme hors du lot) reste refusé, avec son motif', async () => {
      const { svc } = monterParc([
        ferme('r1', jour(8), jour(12)),
        ferme('autre', jour(12), jour(16), { vehicle: { plate: 'AA-1' }, source: 'SYSTEM' }), // de l'agent : hors d'« manuelle »
      ]);
      const res = await svc.reorganiser(makeUser(), {
        ...semaine(), action: 'decaler', decalageMinutes: 90, origine: 'manuelle', simulation: false,
      });
      expect(res.appliquees).toBe(0);
      expect(res.refusees).toEqual([expect.objectContaining({ motif: 'Conflit sur le nouveau créneau.' })]);
    });

    // ─── T2 — l'annulation d'une réservation publique confirmée prévient le demandeur ────────────
    describe('T2 — `reservation.cancelled`', () => {
      const publique = (over: Record<string, unknown> = {}) =>
        futur({ metadata: { public: true, bookingRef: 'g1', requesterContact: 'ecole@test.fr' }, ...over });

      it('annuler une réservation publique CONFIRMÉE à venir : `reservation.cancelled`, jamais « refused »', async () => {
        const { svc, emitter } = monter({ row: publique() });
        await svc.cancel(makeUser(), 'r1');
        expect(emis(emitter, 'reservation.cancelled')).toHaveLength(1);
        expect(emis(emitter, 'reservation.cancelled')[0][1]).toEqual(
          expect.objectContaining({ fleetId: 'f1', status: 'CANCELLED', metadata: expect.objectContaining({ bookingRef: 'g1' }) }),
        );
        expect(emis(emitter, 'reservation.refused')).toHaveLength(0);
      });

      it('rien pour une réservation interne, rétroactive, déjà finie ou en cours ; rien en silencieux', async () => {
        for (const row of [
          futur({ metadata: { requesterId: 'u1' } }),
          publique({ metadata: { public: true, requesterContact: 'a@b.fr', retroactive: true } }),
          publique({ startAt: new Date(Date.now() - 5 * H), endAt: new Date(Date.now() - 2 * H) }),
          publique({ status: 'IN_PROGRESS' }),
        ]) {
          const { svc, emitter } = monter({ row });
          await svc.cancel(makeUser(), 'r1');
          expect(emis(emitter, 'reservation.cancelled')).toHaveLength(0);
        }
        for (const status of ['CONFIRMED', 'REQUESTED']) {
          const { svc, emitter } = monter({ row: publique({ status }) });
          await svc.cancel(makeUser(), 'r1', { silencieux: true });
          expect(emitter.emit).not.toHaveBeenCalled();
        }
      });

      it('Réorganiser → Annuler : UN événement par demande ; « annulée » l’emporte sur « refusée » dans une même demande', async () => {
        const debut = new Date(Date.now() + 48 * H);
        const ligne = (id: string, vehicleId: string, ref: string, over: Record<string, unknown> = {}) =>
          evRow({
            id, vehicleId, vehicle: { plate: vehicleId.toUpperCase() }, status: 'CONFIRMED', source: 'SYSTEM',
            startAt: debut, endAt: new Date(debut.getTime() + 2 * H),
            metadata: { public: true, bookingRef: ref, requesterContact: `${ref}@test.fr` },
            ...over,
          });
        const { svc, emitter } = monterParc([
          ligne('a', 'v1', 'g1'), ligne('b', 'v2', 'g1'), // g1 : deux lignes fermes
          ligne('c', 'v3', 'g2', { status: 'REQUESTED' }), ligne('d', 'v4', 'g2'), // g2 : une en attente, une ferme
          ligne('e', 'v5', 'g3', { status: 'REQUESTED' }), ligne('f', 'v6', 'g3', { status: 'REQUESTED' }), // g3 : deux en attente
        ]);
        const res = await svc.reorganiser(makeUser(), { ...semaine(), action: 'annuler', origine: 'toutes', simulation: false, attendu: 6 });
        expect(res.appliquees).toBe(6);
        const refDe = (c: unknown[]) => ((c[1] as { metadata: { bookingRef: string } }).metadata.bookingRef);
        expect(emis(emitter, 'reservation.cancelled').map(refDe).sort()).toEqual(['g1', 'g2']);
        expect(emis(emitter, 'reservation.refused').map(refDe)).toEqual(['g3']);
      });
    });

    // ─── T3 — la liste blanche `ids` ─────────────────────────────────────────────────────────
    it('T3 — `ids` : le lot ne garde que ces réservations, en simulation comme à l’application (`attendu` compris)', async () => {
      const { svc } = monterParc([ferme('r1', jour(8), jour(9)), ferme('r2', jour(10), jour(11)), ferme('r3', jour(12), jour(13))]);
      const corps = { ...semaine(), action: 'reaffecter' as const, origine: 'toutes' as const, vehicleId: 'v1', ids: ['r2'] };
      const sim = await svc.reorganiser(makeUser(), corps);
      expect(sim.concernees).toBe(1);
      expect(sim.apercu.map((a) => a.startAt)).toEqual([jour(10).toISOString()]);
      // Les comptes du véhicule restent ceux de toute la fenêtre : la liste blanche ne borne que le lot.
      expect(sim.parVehicule).toEqual([{ vehicleId: 'v1', plate: 'AA-1', n: 3 }]);

      const reaffecter = jest.spyOn(svc, 'reaffecter').mockResolvedValue({} as never);
      const res = await svc.reorganiser(makeUser(), { ...corps, simulation: false, attendu: sim.concernees });
      expect(reaffecter.mock.calls.map((c) => c[1])).toEqual(['r2']);
      expect(res.appliquees).toBe(1);
    });

    it('T3 — une liste blanche VIDE ne garde rien (jamais « vide = tout ») ; illisible -> 400', async () => {
      const { svc } = monterParc([ferme('r1', jour(8), jour(9)), ferme('r2', jour(10), jour(11))]);
      const corps = { ...semaine(), action: 'annuler' as const, origine: 'toutes' as const };
      expect((await svc.reorganiser(makeUser(), { ...corps, ids: [] })).concernees).toBe(0);
      expect((await svc.reorganiser(makeUser(), corps)).concernees).toBe(2);
      await expect(svc.reorganiser(makeUser(), { ...corps, ids: 'r1' as never })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.reorganiser(makeUser(), { ...corps, ids: [42] as never })).rejects.toBeInstanceOf(BadRequestException);
    });

    // ─── T4 — un refus certain s'annonce dès la simulation ───────────────────────────────────
    it('T4 — « réaffecter » : une demande en attente qui déborde sur la coupe est annoncée refusée dès la simulation, avec le motif exact', async () => {
      const jeudi = new Date(Date.now() + 72 * H);
      const demande = evRow({ id: 'demande', status: 'REQUESTED', startAt: new Date(Date.now() + 24 * H), endAt: new Date(Date.now() + 96 * H) });
      const { svc } = monterParc([demande, ferme('ferme', new Date(Date.now() + 80 * H), new Date(Date.now() + 82 * H))]);
      const corps = {
        from: jeudi.toISOString(), to: new Date(Date.now() + 120 * H).toISOString(),
        action: 'reaffecter' as const, origine: 'toutes' as const, vehicleId: 'v1',
      };
      const sim = await svc.reorganiser(makeUser(), corps);
      expect(sim.concernees).toBe(2); // le lot entier : c'est le contrat d'`attendu`
      expect(sim.apercu.map((a) => a.status)).toEqual(['REQUESTED', 'CONFIRMED']);
      expect(sim.refusees).toEqual([{ plate: 'AA-1', startAt: (demande.startAt as Date).toISOString(), motif: expect.stringMatching(/déborde sur l’indisponibilité/) }]);
      // Le motif annoncé est celui que `reaffecter()` rend lui-même.
      await expect(svc.reaffecter(makeUser(), 'demande', { versVehicleId: 'v2', aPartirDe: jeudi.toISOString() })).rejects.toThrow(sim.refusees[0].motif);

      // À l'application, la même règle : la demande n'est pas tentée, le même refus revient, `attendu` passe.
      const reaffecter = jest.spyOn(svc, 'reaffecter').mockResolvedValue({} as never);
      const res = await svc.reorganiser(makeUser(), { ...corps, simulation: false, attendu: sim.concernees });
      expect(reaffecter.mock.calls.map((c) => c[1])).toEqual(['ferme']);
      expect(res.appliquees).toBe(1);
      expect(res.refusees).toEqual(sim.refusees);
    });

    it('T4 — « annuler » et « décaler » n’annoncent aucun refus de ce genre : une demande s’y annule ou s’y décale', async () => {
      const { svc } = monterParc([evRow({ id: 'demande', status: 'REQUESTED', startAt: jour(8), endAt: jour(12) })]);
      const sim = await svc.reorganiser(makeUser(), { ...semaine(), action: 'annuler', origine: 'toutes' });
      expect(sim.concernees).toBe(1);
      expect(sim.refusees).toEqual([]);
    });

    // ─── T13 — le titre suit le motif qu'il reprenait ────────────────────────────────────────
    it('T13 — changer le motif : le titre qui le reprenait suit ; un titre explicite reste ; motif vidé -> « Réservation »', async () => {
      const derive = monter({ row: futur({ title: 'Ramassage nord', metadata: { reason: 'Ramassage nord' } }) });
      await derive.svc.update(makeUser(), 'r1', { reason: 'Sortie piscine' });
      expect(derive.update.mock.calls[0][0].data.title).toBe('Sortie piscine');
      expect(derive.update.mock.calls[0][0].data.metadata.reason).toBe('Sortie piscine');

      // Créée sans motif : le titre par défaut suit aussi.
      const parDefaut = monter({ row: futur({ title: 'Réservation', metadata: { reason: null } }) });
      await parDefaut.svc.update(makeUser(), 'r1', { reason: 'Sortie piscine' });
      expect(parDefaut.update.mock.calls[0][0].data.title).toBe('Sortie piscine');

      // Un titre qui ne venait pas du motif (lien public, API) est gardé.
      const explicite = monter({ row: futur({ title: 'Demande publique → Albi', metadata: { public: true, reason: 'x' } }) });
      await explicite.svc.update(makeUser(), 'r1', { reason: 'Sortie piscine' });
      expect(explicite.update.mock.calls[0][0].data.title).toBeUndefined();

      const vide = monter({ row: futur({ title: 'Ramassage nord', metadata: { reason: 'Ramassage nord' } }) });
      await vide.svc.update(makeUser(), 'r1', { reason: '' });
      expect(vide.update.mock.calls[0][0].data.title).toBe('Réservation');
      expect(vide.update.mock.calls[0][0].data.metadata.reason).toBe('');

      // Un titre fourni gagne toujours ; le même motif renvoyé ne touche pas au titre.
      const fourni = monter({ row: futur({ title: 'Ramassage nord', metadata: { reason: 'Ramassage nord' } }) });
      await fourni.svc.update(makeUser(), 'r1', { reason: 'Sortie piscine', title: 'Navette' });
      expect(fourni.update.mock.calls[0][0].data.title).toBe('Navette');
      await fourni.svc.update(makeUser(), 'r1', { reason: 'Ramassage nord' });
      expect(fourni.update.mock.calls[1][0].data.title).toBeUndefined();
    });

    it('T13 — une réservation commencée qu’on scinde en changeant le motif : les deux parties portent le nouveau titre', async () => {
      const row = evRow({
        status: 'CONFIRMED', title: 'Ramassage nord', startAt: new Date(Date.now() - 2 * H), endAt: new Date(Date.now() + 2 * H),
        metadata: { reason: 'Ramassage nord' },
      });
      const { svc, update, create } = monter({ row });
      await svc.update(makeUser(), 'r1', { vehicleId: 'v2', reason: 'Sortie piscine' });
      expect(update.mock.calls[0][0].data.title).toBe('Sortie piscine');
      expect(create.mock.calls[0][0].data.title).toBe('Sortie piscine');
    });
  });
});
