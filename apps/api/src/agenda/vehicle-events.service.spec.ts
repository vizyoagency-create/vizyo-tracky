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

  it('reportIncident : immobilise le véhicule par défaut (blocksVehicle=true)', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicle: { findUnique: jest.Mock }; vehicleEvent: { create: jest.Mock } };
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'f1' });
    p.vehicleEvent.create.mockResolvedValue({
      id: 'e1', fleetId: 'f1', vehicleId: 'v1', vehicle: { plate: 'AA-1' }, type: 'INCIDENT', status: 'OPEN',
      severity: 'MEDIUM', title: 'Roue crevée', description: null, startAt: new Date(), endAt: null, allDay: true,
      blocksVehicle: true, odometerKm: null, planId: null, linkedEventId: null, resolvedAt: null, metadata: null,
      source: 'MANUAL', createdAt: new Date(), updatedAt: new Date(),
    });
    const svc = new VehicleEventsService(prisma, access('ALL'));
    const dto = await svc.reportIncident(makeUser({ role: UserRole.FLEET_ADMIN }), { vehicleId: 'v1', title: 'Roue crevée' });
    expect(p.vehicleEvent.create.mock.calls[0][0].data.blocksVehicle).toBe(true);
    expect(dto.blocksVehicle).toBe(true);
  });

  it('create : MAINTENANCE n\'immobilise pas par défaut, INCIDENT si', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicle: { findUnique: jest.Mock }; vehicleEvent: { create: jest.Mock } };
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'f1', lastOdometerAt: null });
    p.vehicleEvent.create.mockResolvedValue({
      id: 'e1', fleetId: 'f1', vehicleId: 'v1', vehicle: { plate: 'AA-1' }, type: 'MAINTENANCE', status: 'PLANNED',
      severity: null, title: 'Vidange', description: null, startAt: new Date(), endAt: null, allDay: true,
      blocksVehicle: false, odometerKm: null, planId: null, linkedEventId: null, resolvedAt: null, metadata: null,
      source: 'MANUAL', createdAt: new Date(), updatedAt: new Date(),
    });
    const svc = new VehicleEventsService(prisma, access('ALL'));
    const base = { vehicleId: 'v1', title: 'x', startAt: new Date().toISOString() };
    await svc.create(makeUser({ role: UserRole.FLEET_ADMIN }), { ...base, type: 'MAINTENANCE' });
    expect(p.vehicleEvent.create.mock.calls[0][0].data.blocksVehicle).toBe(false);
    await svc.create(makeUser({ role: UserRole.FLEET_ADMIN }), { ...base, type: 'INCIDENT' });
    expect(p.vehicleEvent.create.mock.calls[1][0].data.blocksVehicle).toBe(true);
    // Choix explicite de l'utilisateur respecté (incident mineur non immobilisant).
    await svc.create(makeUser({ role: UserRole.FLEET_ADMIN }), { ...base, type: 'INCIDENT', blocksVehicle: false });
    expect(p.vehicleEvent.create.mock.calls[2][0].data.blocksVehicle).toBe(false);
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

/**
 * ── P2-1 (audit du 22/09) — UNE MISSION NE SE TOUCHE PAS DEPUIS L'AGENDA ──────────────────
 *
 * L'évènement `MISSION` est l'ombre d'une mission, créée avec elle dans une transaction et
 * retrouvée par `metadata.missionId`. Le serveur refusait déjà la RÉSERVATION par cette voie mais
 * laissait passer la mission : « Terminé » ou « Supprimer » depuis le panneau du jour libérait le
 * véhicule pendant une mission qui existait toujours. Dormant chez cdef31 (0 mission), actif chez
 * mh cars (7).
 */
describe('VehicleEventsService — la garde MISSION (P2-1)', () => {
  function prismaAvec(type: string) {
    const prisma = makePrisma();
    const p = prisma as { vehicleEvent: { findFirst: jest.Mock; update: jest.Mock; delete: jest.Mock } };
    p.vehicleEvent.findFirst.mockResolvedValue({ id: 'e1', vehicleId: 'v1', type });
    p.vehicleEvent.update.mockResolvedValue({
      id: 'e1', fleetId: 'f1', vehicleId: 'v1', vehicle: { plate: 'AA-1' }, type, status: 'DONE',
      severity: null, title: 'x', description: null, startAt: new Date(), endAt: null, allDay: true,
      blocksVehicle: false, odometerKm: null, planId: null, linkedEventId: null, resolvedAt: new Date(),
      metadata: null, source: 'MANUAL', createdAt: new Date(), updatedAt: new Date(),
    });
    p.vehicleEvent.delete.mockResolvedValue({});
    return { prisma, p };
  }
  const admin = () => makeUser({ role: UserRole.FLEET_ADMIN });

  it('update : « Terminé » sur une MISSION est refusé, et le message dit où aller', async () => {
    const { prisma, p } = prismaAvec('MISSION');
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await expect(svc.update(admin(), 'e1', { status: 'DONE' })).rejects.toMatchObject({
      constructor: BadRequestException,
      message: expect.stringContaining('onglet Missions'),
    });
    expect(p.vehicleEvent.update).not.toHaveBeenCalled();
  });

  it('remove : supprimer une MISSION est refusé — la mission survivrait sans son ombre', async () => {
    const { prisma, p } = prismaAvec('MISSION');
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await expect(svc.remove(admin(), 'e1')).rejects.toBeInstanceOf(BadRequestException);
    expect(p.vehicleEvent.delete).not.toHaveBeenCalled();
  });

  it('…mais une MAINTENANCE se termine et se supprime toujours par cette voie', async () => {
    const { prisma, p } = prismaAvec('MAINTENANCE');
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await expect(svc.update(admin(), 'e1', { status: 'DONE' })).resolves.toMatchObject({ status: 'DONE' });
    await expect(svc.remove(admin(), 'e1')).resolves.toEqual({ ok: true });
    expect(p.vehicleEvent.update).toHaveBeenCalledTimes(1);
    expect(p.vehicleEvent.delete).toHaveBeenCalledTimes(1);
  });
});

/**
 * ── LES COMPTEURS (audit du 24/09 « compteur ≠ liste », et P2-4) ─────────────────────────
 *
 * `overdue` ne comptait que les PLANNED alors que le contrat du DTO disait « PLANNED/OPEN » et
 * que la liste affichait les OPEN. Et filtrer par groupe ou véhicule ne changeait pas les
 * compteurs : l'écran suggérait un périmètre qu'il n'appliquait pas.
 *
 * Recette du 28/09 (démo) : compter les OPEN faisait passer un incident déclaré à l'instant pour
 * « en retard ». Un OPEN est OUVERT (`openIncidents`) ; seul un PLANNED a une échéance à dépasser.
 * Le contrat du DTO et la règle web (`estUneEcheance`) disent la même chose depuis ce jour.
 */
describe('VehicleEventsService — summary : statuts et périmètre', () => {
  const countOf = (prisma: unknown) => (prisma as { vehicleEvent: { count: jest.Mock } }).vehicleEvent.count;

  it('« En retard » compte les seuls PLANNED dont l’échéance est passée — comme la liste ; un OPEN est ouvert, pas en retard', async () => {
    const prisma = makePrisma();
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await svc.summary(makeUser());
    const enRetard = countOf(prisma).mock.calls[0][0].where;
    expect(enRetard.status).toBe('PLANNED');
    expect(enRetard.startAt).toEqual({ lt: expect.any(Date) });
  });

  it('un véhicule filtré borne les trois compteurs à ce véhicule', async () => {
    const prisma = makePrisma();
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await svc.summary(makeUser(), { vehicleId: 'v7' });
    for (const appel of countOf(prisma).mock.calls) {
      expect(appel[0].where.vehicleId).toEqual({ in: ['v7'] });
    }
  });

  it('un groupe filtré se résout en ses véhicules ; un groupe VIDE rend trois zéros sans interroger', async () => {
    const prisma = makePrisma({ vehicleGroupAssignment: { findMany: jest.fn().mockResolvedValue([{ vehicleId: 'v1' }, { vehicleId: 'v2' }]) } });
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await svc.summary(makeUser(), { groupId: 'g1' });
    expect(countOf(prisma).mock.calls[0][0].where.vehicleId).toEqual({ in: ['v1', 'v2'] });

    const vide = makePrisma();
    const svcVide = new VehicleEventsService(vide, access('ALL'));
    await expect(svcVide.summary(makeUser(), { groupId: 'g-vide' })).resolves.toEqual({ overdue: 0, upcoming: 0, openIncidents: 0 });
    expect(countOf(vide)).not.toHaveBeenCalled();
  });
});
