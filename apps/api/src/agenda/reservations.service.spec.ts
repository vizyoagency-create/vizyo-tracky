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
      findUnique: jest.fn().mockResolvedValue({ tracker: { id: 't1', lastSeenAt: new Date() } }),
    },
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

  function build(lastSeenAt: Date | null, trackerId: string | null = 't1') {
    const prisma = makePrisma({
      vehicle: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ tracker: trackerId ? { id: trackerId, lastSeenAt } : null }),
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
