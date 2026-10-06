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

  it('create : MAINTENANCE et INCIDENT immobilisent par défaut (06/10/2026), le choix explicite est respecté', async () => {
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
    // Demande du propriétaire du 06/10/2026 : « si on ajoute une maintenance à une voiture, elle doit
    // passer avec le rond marron et la clé » — une maintenance rend le véhicule indisponible.
    await svc.create(makeUser({ role: UserRole.FLEET_ADMIN }), { ...base, type: 'MAINTENANCE' });
    expect(p.vehicleEvent.create.mock.calls[0][0].data.blocksVehicle).toBe(true);
    await svc.create(makeUser({ role: UserRole.FLEET_ADMIN }), { ...base, type: 'INCIDENT' });
    expect(p.vehicleEvent.create.mock.calls[1][0].data.blocksVehicle).toBe(true);
    // Choix explicite de l'utilisateur respecté (incident mineur non immobilisant).
    await svc.create(makeUser({ role: UserRole.FLEET_ADMIN }), { ...base, type: 'INCIDENT', blocksVehicle: false });
    expect(p.vehicleEvent.create.mock.calls[2][0].data.blocksVehicle).toBe(false);
    // … et pour une maintenance qui laisse le véhicule disponible (« Immobilise le véhicule » décoché).
    await svc.create(makeUser({ role: UserRole.FLEET_ADMIN }), { ...base, type: 'MAINTENANCE', blocksVehicle: false });
    expect(p.vehicleEvent.create.mock.calls[3][0].data.blocksVehicle).toBe(false);
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
 * Troisième relecture du 29/09 (T16) — un incident OUVERT bloquant, sans date de fin, signalé AVANT la
 * fenêtre (le 20/08, grille de septembre) n'était rendu par aucune liste : le panneau du jour disait le
 * véhicule disponible, et la réservation répondait 409 (`findImmobilized` le tient bloquant jusqu'à
 * résolution). La fenêtre rend désormais toute immobilisation SANS FIN encore active — même prédicat.
 *
 * Le filtre envoyé à Prisma est ÉVALUÉ ici (opérateurs réellement employés : égalité, null, gte, lte,
 * lt, gt, in, notIn) sur des lignes types : on teste ce que la requête RAMÈNE, pas sa forme.
 */
describe('VehicleEventsService.list — immobilisation sans fin commencée avant la fenêtre (T16)', () => {
  const DAY = 86_400_000;
  const from = new Date('2026-08-30T22:00:00Z'); // lundi 31/08, minuit à Paris
  const to = new Date('2026-10-11T22:00:00Z');

  type Ligne = { type: string; status: string; blocksVehicle: boolean; startAt: Date; endAt: Date | null };
  function correspond(ligne: Ligne, clause: Record<string, unknown>): boolean {
    return Object.entries(clause).every(([champ, attendu]) => {
      const v = (ligne as unknown as Record<string, unknown>)[champ];
      if (attendu === null) return v === null;
      if (attendu instanceof Date || typeof attendu !== 'object') return v === attendu;
      const op = attendu as { gte?: Date; lte?: Date; lt?: Date; gt?: Date; in?: unknown[]; notIn?: unknown[] };
      if (v === null || v === undefined) return false;
      if (op.in && !op.in.includes(v)) return false;
      if (op.notIn && op.notIn.includes(v)) return false;
      const t = v instanceof Date ? v.getTime() : Number.NaN;
      if (op.gte && !(t >= op.gte.getTime())) return false;
      if (op.lte && !(t <= op.lte.getTime())) return false;
      if (op.lt && !(t < op.lt.getTime())) return false;
      if (op.gt && !(t > op.gt.getTime())) return false;
      return true;
    });
  }
  async function fenetre() {
    const prisma = makePrisma();
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await svc.list(makeUser(), { from, to });
    const where = (prisma as { vehicleEvent: { findMany: jest.Mock } }).vehicleEvent.findMany.mock.calls[0][0].where;
    const branches = where.AND[0].OR as Record<string, unknown>[];
    return (l: Ligne) => branches.some((b) => correspond(l, b));
  }
  const incident = (over: Partial<Ligne> = {}): Ligne => ({
    type: 'INCIDENT', status: 'OPEN', blocksVehicle: true, startAt: new Date('2026-08-20T10:00:00Z'), endAt: null, ...over,
  });

  it('l’incident OPEN bloquant du 20/08, jamais résolu, est rendu à la grille de septembre', async () => {
    const rendu = await fenetre();
    expect(rendu(incident())).toBe(true);
    expect(rendu(incident({ status: 'IN_PROGRESS', startAt: new Date(from.getTime() - 40 * DAY) }))).toBe(true);
  });

  it('…mais pas un incident résolu, non bloquant, ni une réservation', async () => {
    const rendu = await fenetre();
    expect(rendu(incident({ status: 'RESOLVED' }))).toBe(false);
    expect(rendu(incident({ blocksVehicle: false }))).toBe(false);
    expect(rendu(incident({ type: 'RESERVATION', status: 'CONFIRMED' }))).toBe(false);
  });

  it('une maintenance SANS fin bloque sa journée (24 h) : commencée la veille au matin, rendue ; l’avant-veille, non', async () => {
    const rendu = await fenetre();
    const maintenance = (startAt: Date): Ligne => ({ type: 'MAINTENANCE', status: 'PLANNED', blocksVehicle: true, startAt, endAt: null });
    expect(rendu(maintenance(new Date(from.getTime() - 10 * 3_600_000)))).toBe(true);
    expect(rendu(maintenance(new Date(from.getTime() - 2 * DAY)))).toBe(false);
  });

  it('inchangé : un évènement dans la fenêtre, ou qui la chevauche avec une fin, est rendu ; un évènement clos avant, non', async () => {
    const rendu = await fenetre();
    expect(rendu(incident({ startAt: new Date(from.getTime() + DAY), status: 'RESOLVED' }))).toBe(true);
    expect(rendu({ type: 'MAINTENANCE', status: 'DONE', blocksVehicle: false, startAt: new Date(from.getTime() - DAY), endAt: new Date(from.getTime() + DAY) })).toBe(true);
    expect(rendu({ type: 'MAINTENANCE', status: 'DONE', blocksVehicle: true, startAt: new Date(from.getTime() - 3 * DAY), endAt: new Date(from.getTime() - 2 * DAY) })).toBe(false);
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
/**
 * Lot multi-jours (28/09) : « un véhicule en garage, ça peut prendre une semaine ». La fin se
 * saisit désormais ; elle doit rester après le début, à la création comme à la modification —
 * sinon l'immobilisation calculée serait vide et le véhicule « libre » pendant son passage au garage.
 */
describe('VehicleEventsService — la fin après le début (multi-jours)', () => {
  const admin = () => makeUser({ role: UserRole.FLEET_ADMIN });
  const ligne = (endAt: Date | null) => ({
    id: 'e1', fleetId: 'f1', vehicleId: 'v1', vehicle: { plate: 'AA-1' }, type: 'MAINTENANCE', status: 'IN_PROGRESS',
    severity: null, title: 'Garage', description: null, startAt: new Date('2026-10-05T08:00:00Z'), endAt, allDay: true,
    blocksVehicle: true, odometerKm: null, planId: null, linkedEventId: null, resolvedAt: null, metadata: null,
    source: 'MANUAL', createdAt: new Date(), updatedAt: new Date(),
  });

  it('create : une fin avant (ou égale à) le début est refusée, rien n\'est écrit', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicle: { findUnique: jest.Mock }; vehicleEvent: { create: jest.Mock } };
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'f1', lastOdometerAt: null });
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await expect(
      svc.create(admin(), { vehicleId: 'v1', type: 'MAINTENANCE', title: 'Garage', startAt: '2026-10-05T08:00:00Z', endAt: '2026-10-05T08:00:00Z' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(p.vehicleEvent.create).not.toHaveBeenCalled();
  });

  it('create : du 5 au 12, la fin est écrite telle quelle', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicle: { findUnique: jest.Mock }; vehicleEvent: { create: jest.Mock } };
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'f1', lastOdometerAt: null });
    p.vehicleEvent.create.mockResolvedValue(ligne(new Date('2026-10-12T18:00:00Z')));
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await svc.create(admin(), { vehicleId: 'v1', type: 'MAINTENANCE', title: 'Garage', startAt: '2026-10-05T08:00:00Z', endAt: '2026-10-12T18:00:00Z' });
    expect(p.vehicleEvent.create.mock.calls[0][0].data.endAt).toEqual(new Date('2026-10-12T18:00:00Z'));
  });

  it('update : reculer la fin avant le début est refusé — même sans toucher au début', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicleEvent: { findFirst: jest.Mock; update: jest.Mock } };
    p.vehicleEvent.findFirst.mockResolvedValue({ id: 'e1', vehicleId: 'v1', type: 'MAINTENANCE', startAt: new Date('2026-10-05T08:00:00Z'), endAt: new Date('2026-10-12T18:00:00Z') });
    const svc = new VehicleEventsService(prisma, access('ALL'));
    await expect(svc.update(admin(), 'e1', { endAt: '2026-10-04T18:00:00Z' })).rejects.toBeInstanceOf(BadRequestException);
    expect(p.vehicleEvent.update).not.toHaveBeenCalled();
  });

  it('update : « terminée ? Non, jusqu\'au 20 » repousse la fin — c\'est la réponse de l\'écran « À clore »', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicleEvent: { findFirst: jest.Mock; update: jest.Mock } };
    p.vehicleEvent.findFirst.mockResolvedValue({ id: 'e1', vehicleId: 'v1', type: 'MAINTENANCE', startAt: new Date('2026-10-05T08:00:00Z'), endAt: new Date('2026-10-12T18:00:00Z') });
    p.vehicleEvent.update.mockResolvedValue(ligne(new Date('2026-10-20T18:00:00Z')));
    const svc = new VehicleEventsService(prisma, access('ALL'));
    const dto = await svc.update(admin(), 'e1', { endAt: '2026-10-20T18:00:00Z' });
    expect(p.vehicleEvent.update.mock.calls[0][0].data.endAt).toEqual(new Date('2026-10-20T18:00:00Z'));
    expect(dto.endAt).toBe('2026-10-20T18:00:00.000Z');
  });
});

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

/**
 * ── JOURNAL MÉTIER (29/09) ───────────────────────────────────────────────────────────────────
 *
 * Chaque geste sur un évènement d'agenda laisse une ligne AGENDA au journal, lue par le fil de la
 * société. Verrouillé ici : la société est celle de l'ÉVÈNEMENT (un super-admin, sans société
 * propre, agit chez un client), l'auteur est l'utilisateur réel, les heures du texte sont celles de
 * PARIS, une suppression est écrite AVANT d'effacer ce qu'elle décrit, et un journal absent ou en
 * panne ne fait jamais échouer le geste.
 */
describe('VehicleEventsService — journal métier (29/09)', () => {
  const superAdmin = () => makeUser({ id: 'u-sa', role: UserRole.SUPER_ADMIN, fleetId: null });
  const journal = () => ({ record: jest.fn() });
  // 05/10/2026 07:00Z = 09:00 à Paris (heure d'été).
  const ligne = (over: Record<string, unknown> = {}) => ({
    id: 'e1', fleetId: 'fCLIENT', vehicleId: 'v1', vehicle: { plate: 'AA-1' }, type: 'MAINTENANCE', status: 'PLANNED',
    severity: null, title: 'Vidange', description: null, startAt: new Date('2026-10-05T07:00:00Z'), endAt: new Date('2026-10-05T10:00:00Z'),
    allDay: false, blocksVehicle: true, odometerKm: null, planId: null, linkedEventId: null, resolvedAt: null, metadata: null,
    source: 'MANUAL', createdAt: new Date(), updatedAt: new Date(), ...over,
  });
  const charge = (over: Record<string, unknown> = {}) => ({
    id: 'e1', vehicleId: 'v1', type: 'MAINTENANCE', startAt: new Date('2026-10-05T07:00:00Z'), endAt: new Date('2026-10-05T10:00:00Z'),
    fleetId: 'fCLIENT', status: 'IN_PROGRESS', title: 'Vidange', allDay: false, blocksVehicle: true, vehicle: { plate: 'AA-1' }, ...over,
  });
  type P = { vehicle: { findUnique: jest.Mock }; vehicleEvent: { create: jest.Mock; findFirst: jest.Mock; update: jest.Mock; delete: jest.Mock } };

  it('create (maintenance) → evenement_cree, société du VÉHICULE et non de l’utilisateur, auteur réel, heure de Paris', async () => {
    const prisma = makePrisma();
    const p = prisma as P;
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'fCLIENT', lastOdometerAt: null });
    p.vehicleEvent.create.mockResolvedValue(ligne());
    const j = journal();
    const svc = new VehicleEventsService(prisma, access('ALL'), undefined, j as never);

    await svc.create(superAdmin(), { vehicleId: 'v1', type: 'MAINTENANCE', title: 'Vidange', startAt: '2026-10-05T07:00:00Z', endAt: '2026-10-05T10:00:00Z', allDay: false });

    expect(j.record).toHaveBeenCalledTimes(1);
    const l = j.record.mock.calls[0][0];
    expect(l).toEqual(expect.objectContaining({
      category: 'AGENDA', action: 'evenement_cree', actor: 'utilisateur', target: 'AA-1', fleetId: 'fCLIENT', triggeredByUserId: 'u-sa',
    }));
    expect(l.detail).toContain('Maintenance « Vidange »');
    expect(l.detail).toContain('05/10/2026 09:00 → 12:00');
    expect(l.detail).toContain('véhicule indisponible');
    expect(l.meta).toEqual(expect.objectContaining({ eventId: 'e1', vehicleId: 'v1', type: 'MAINTENANCE' }));
  });

  it('create d’un INCIDENT par la feuille → incident_signale (même libellé que le bouton dédié)', async () => {
    const prisma = makePrisma();
    const p = prisma as P;
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'fCLIENT', lastOdometerAt: null });
    p.vehicleEvent.create.mockResolvedValue(ligne({ type: 'INCIDENT', status: 'OPEN', title: 'Pare-brise' }));
    const j = journal();
    const svc = new VehicleEventsService(prisma, access('ALL'), undefined, j as never);

    await svc.create(superAdmin(), { vehicleId: 'v1', type: 'INCIDENT', title: 'Pare-brise', startAt: '2026-10-05T07:00:00Z' });

    expect(j.record.mock.calls[0][0].action).toBe('incident_signale');
  });

  it('reportIncident → incident_signale, société du véhicule, gravité et immobilisation dites', async () => {
    const prisma = makePrisma();
    const p = prisma as P;
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'fCLIENT' });
    p.vehicleEvent.create.mockResolvedValue(ligne({ type: 'INCIDENT', status: 'OPEN', title: 'Roue crevée', severity: 'HIGH', endAt: null, allDay: true }));
    const j = journal();
    const svc = new VehicleEventsService(prisma, access('ALL'), undefined, j as never);

    await svc.reportIncident(superAdmin(), { vehicleId: 'v1', title: 'Roue crevée', severity: 'HIGH' });

    const l = j.record.mock.calls[0][0];
    expect(l).toEqual(expect.objectContaining({ category: 'AGENDA', action: 'incident_signale', fleetId: 'fCLIENT', triggeredByUserId: 'u-sa', target: 'AA-1' }));
    expect(l.detail).toContain('Incident « Roue crevée » signalé le 05/10/2026 09:00');
    expect(l.detail).toContain('gravité haute');
    expect(l.detail).toContain('véhicule immobilisé');
  });

  it('update qui passe le statut à DONE → evenement_clos ; société de l’évènement', async () => {
    const prisma = makePrisma();
    const p = prisma as P;
    p.vehicleEvent.findFirst.mockResolvedValue(charge());
    p.vehicleEvent.update.mockResolvedValue(ligne({ status: 'DONE', resolvedAt: new Date() }));
    const j = journal();
    const svc = new VehicleEventsService(prisma, access('ALL'), undefined, j as never);

    await svc.update(superAdmin(), 'e1', { status: 'DONE' });

    const l = j.record.mock.calls[0][0];
    expect(l).toEqual(expect.objectContaining({ category: 'AGENDA', action: 'evenement_clos', fleetId: 'fCLIENT', triggeredByUserId: 'u-sa', target: 'AA-1' }));
    expect(l.detail).toContain('Clôture : Maintenance « Vidange »');
    expect(l.meta.avant.status).toBe('IN_PROGRESS');
    expect(l.meta.apres.status).toBe('DONE');
  });

  it('update d’un évènement DÉJÀ clos (DONE réécrit) : ni clôture ni modification — aucune ligne ; repousser la fin → evenement_modifie en heure de Paris', async () => {
    const prisma = makePrisma();
    const p = prisma as P;
    p.vehicleEvent.findFirst.mockResolvedValueOnce(charge({ status: 'DONE' }));
    p.vehicleEvent.update.mockResolvedValueOnce(ligne({ status: 'DONE' }));
    const j = journal();
    const svc = new VehicleEventsService(prisma, access('ALL'), undefined, j as never);

    // Revue du 29/09 (C2) : un DONE réécrit sur un DONE ne change rien → pas de ligne.
    await svc.update(superAdmin(), 'e1', { status: 'DONE' });
    expect(j.record).not.toHaveBeenCalled();

    // Repousser la fin : « dates … → … », en heure de Paris (12:00 → 18:00, pas 10:00Z → 16:00Z).
    p.vehicleEvent.findFirst.mockResolvedValueOnce(charge());
    p.vehicleEvent.update.mockResolvedValueOnce(ligne({ status: 'IN_PROGRESS', endAt: new Date('2026-10-05T16:00:00Z') }));
    await svc.update(superAdmin(), 'e1', { endAt: '2026-10-05T16:00:00Z' });
    const l = j.record.mock.calls[0][0];
    expect(l.action).toBe('evenement_modifie');
    expect(l.detail).toContain('dates 05/10/2026 09:00 → 12:00, désormais 05/10/2026 09:00 → 18:00');
    expect(l.meta.champs).toEqual(['endAt']);
  });

  /**
   * Revue du 29/09 (C2) — la feuille d'édition (agenda.component, `submitCreate` en édition) renvoie
   * TOUJOURS titre, catégorie, description, dates, journée entière, immobilisation, la gravité d'un
   * incident et le kilométrage s'il est connu — `''` là où la base a `null`. Le journal ne nommait
   * que ce qui était ENVOYÉ : « description, catégorie mis à jour » à chaque report, et une ligne
   * même quand on cliquait Enregistrer sans rien toucher.
   */
  describe('update par la feuille d’édition : ne nommer que ce qui change (C2)', () => {
    // Maintenance du 05/10 09:00 → 12:00 (Paris), telle qu'en base : catégorie et description NULL.
    const enBase = (over: Record<string, unknown> = {}) =>
      charge({
        status: 'PLANNED', description: null, category: null, severity: null, odometerKm: 12000,
        linkedEventId: null, metadata: { source: 'plan' }, ...over,
      });
    // Ce que la feuille envoie quand on ne touche à rien.
    const feuille = (over: Record<string, unknown> = {}) => ({
      title: 'Vidange', category: '', description: '', startAt: '2026-10-05T07:00:00.000Z', endAt: '2026-10-05T10:00:00.000Z',
      allDay: false, blocksVehicle: true, odometerKm: 12000, ...over,
    });
    // La ligne réécrite : la feuille a écrit '' dans catégorie et description.
    const reecrite = (over: Record<string, unknown> = {}) =>
      ligne({ status: 'PLANNED', category: '', description: '', odometerKm: 12000, metadata: { source: 'plan' }, ...over });

    function monter(avant: ReturnType<typeof enBase>, apres: ReturnType<typeof reecrite>) {
      const prisma = makePrisma();
      const p = prisma as P;
      p.vehicleEvent.findFirst.mockResolvedValue(avant);
      p.vehicleEvent.update.mockResolvedValue(apres);
      p.vehicle.findUnique.mockResolvedValue({ lastOdometerAt: null });
      const j = journal();
      return { svc: new VehicleEventsService(prisma, access('ALL'), undefined, j as never), j, p };
    }

    it('Enregistrer sans rien toucher (\'\' renvoyé pour un null en base) → AUCUNE ligne, mais l’écriture a bien lieu', async () => {
      const { svc, j, p } = monter(enBase(), reecrite());

      await expect(svc.update(superAdmin(), 'e1', feuille())).resolves.toMatchObject({ id: 'e1' });

      expect(p.vehicleEvent.update).toHaveBeenCalledTimes(1);
      expect(j.record).not.toHaveBeenCalled();
    });

    it('repousser la fin seule → le détail ne nomme QUE les dates ; champs = [endAt]', async () => {
      const { svc, j } = monter(enBase(), reecrite({ endAt: new Date('2026-10-05T16:00:00Z') }));

      await svc.update(superAdmin(), 'e1', feuille({ endAt: '2026-10-05T16:00:00.000Z' }));

      const l = j.record.mock.calls[0][0];
      expect(l.action).toBe('evenement_modifie');
      expect(l.detail).toBe('Modification : Maintenance « Vidange » — dates 05/10/2026 09:00 → 12:00, désormais 05/10/2026 09:00 → 18:00');
      expect(l.detail).not.toMatch(/description|catégorie|gravité|kilométrage|mis à jour/);
      expect(l.meta.champs).toEqual(['endAt']);
    });

    it('incident : gravité et kilométrage changés → « avant → après » ; gravité inchangée → non nommée', async () => {
      const incident = { type: 'INCIDENT', title: 'Pare-brise' };
      const { svc, j } = monter(
        enBase({ ...incident, severity: 'MEDIUM' }),
        reecrite({ ...incident, severity: 'HIGH', odometerKm: 12450 }),
      );

      await svc.update(superAdmin(), 'e1', feuille({ title: 'Pare-brise', severity: 'HIGH', odometerKm: 12450 }));

      const l = j.record.mock.calls[0][0];
      expect(l.detail).toContain('gravité moyenne → haute');
      expect(l.detail).toContain('kilométrage 12 000 km → 12 450 km');
      expect(l.detail).not.toMatch(/description|catégorie|dates/);
      expect(l.meta.champs).toEqual(['severity', 'odometerKm']);

      const second = monter(enBase({ ...incident, severity: 'HIGH' }), reecrite({ ...incident, severity: 'HIGH' }));
      await second.svc.update(superAdmin(), 'e1', feuille({ title: 'Pare-brise', severity: 'HIGH' }));
      expect(second.j.record).not.toHaveBeenCalled();
    });

    it('catégorie et description réellement saisies → nommées ; la catégorie avec ses valeurs', async () => {
      const { svc, j } = monter(enBase(), reecrite({ category: 'Carrosserie', description: 'Rayure porte' }));

      await svc.update(superAdmin(), 'e1', feuille({ category: 'Carrosserie', description: 'Rayure porte' }));

      const l = j.record.mock.calls[0][0];
      expect(l.detail).toContain('catégorie — → « Carrosserie »');
      expect(l.detail).toContain('description mise à jour');
      expect(l.meta.champs).toEqual(['category', 'description']);
    });

    it('une clôture reste TOUJOURS une ligne, même si rien d’autre ne change', async () => {
      const { svc, j } = monter(enBase({ status: 'IN_PROGRESS' }), reecrite({ status: 'DONE' }));

      await svc.update(superAdmin(), 'e1', { status: 'DONE' });

      expect(j.record).toHaveBeenCalledTimes(1);
      expect(j.record.mock.calls[0][0].action).toBe('evenement_clos');
    });
  });

  it('remove → evenement_supprime écrit AVANT la suppression (titre, type, plaque, société de l’évènement)', async () => {
    const prisma = makePrisma();
    const p = prisma as P;
    p.vehicleEvent.findFirst.mockResolvedValue(charge());
    p.vehicleEvent.delete.mockResolvedValue({});
    const j = journal();
    const svc = new VehicleEventsService(prisma, access('ALL'), undefined, j as never);

    await expect(svc.remove(superAdmin(), 'e1')).resolves.toEqual({ ok: true });

    expect(j.record.mock.invocationCallOrder[0]).toBeLessThan(p.vehicleEvent.delete.mock.invocationCallOrder[0]);
    const l = j.record.mock.calls[0][0];
    expect(l).toEqual(expect.objectContaining({ category: 'AGENDA', action: 'evenement_supprime', fleetId: 'fCLIENT', triggeredByUserId: 'u-sa', target: 'AA-1' }));
    expect(l.detail).toContain('Suppression : Maintenance « Vidange »');
    expect(l.meta).toEqual(expect.objectContaining({ eventId: 'e1', type: 'MAINTENANCE', title: 'Vidange' }));
  });

  it('remove dont la suppression échoue : une seconde ligne EN ÉCHEC le dit, et l’erreur remonte', async () => {
    const prisma = makePrisma();
    const p = prisma as P;
    p.vehicleEvent.findFirst.mockResolvedValue(charge());
    p.vehicleEvent.delete.mockRejectedValue(new Error('verrou'));
    const j = journal();
    const svc = new VehicleEventsService(prisma, access('ALL'), undefined, j as never);

    await expect(svc.remove(superAdmin(), 'e1')).rejects.toThrow('verrou');
    expect(j.record).toHaveBeenCalledTimes(2);
    expect(j.record.mock.calls[1][0]).toEqual(expect.objectContaining({ action: 'evenement_supprime', status: 'FAILURE', fleetId: 'fCLIENT' }));
  });

  it('refus (réservation, mission) : aucune ligne', async () => {
    const prisma = makePrisma();
    const p = prisma as P;
    p.vehicleEvent.findFirst.mockResolvedValue(charge({ type: 'MISSION' }));
    const j = journal();
    const svc = new VehicleEventsService(prisma, access('ALL'), undefined, j as never);

    await expect(svc.remove(superAdmin(), 'e1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(superAdmin(), 'e1', { status: 'DONE' })).rejects.toBeInstanceOf(BadRequestException);
    expect(j.record).not.toHaveBeenCalled();
  });

  it('journal EN PANNE (record lève) : create, update et remove passent quand même', async () => {
    const prisma = makePrisma();
    const p = prisma as P;
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'fCLIENT', lastOdometerAt: null });
    p.vehicleEvent.create.mockResolvedValue(ligne());
    p.vehicleEvent.findFirst.mockResolvedValue(charge());
    p.vehicleEvent.update.mockResolvedValue(ligne({ status: 'DONE' }));
    p.vehicleEvent.delete.mockResolvedValue({});
    const enPanne = { record: jest.fn(() => { throw new Error('journal HS'); }) };
    const svc = new VehicleEventsService(prisma, access('ALL'), undefined, enPanne as never);

    await expect(svc.create(superAdmin(), { vehicleId: 'v1', type: 'MAINTENANCE', title: 'Vidange', startAt: '2026-10-05T07:00:00Z' })).resolves.toMatchObject({ id: 'e1' });
    await expect(svc.update(superAdmin(), 'e1', { status: 'DONE' })).resolves.toMatchObject({ status: 'DONE' });
    await expect(svc.remove(superAdmin(), 'e1')).resolves.toEqual({ ok: true });
    expect(enPanne.record).toHaveBeenCalledTimes(3);
  });

  it('journal ABSENT (specs montées à la main, 2 paramètres) : aucun effet, aucune erreur', async () => {
    const prisma = makePrisma();
    const p = prisma as P;
    p.vehicleEvent.findFirst.mockResolvedValue(charge());
    p.vehicleEvent.delete.mockResolvedValue({});
    const svc = new VehicleEventsService(prisma, access('ALL'));

    await expect(svc.remove(superAdmin(), 'e1')).resolves.toEqual({ ok: true });
  });
});

/**
 * 06/10/2026 — une maintenance ou un incident change l'état de disponibilité du véhicule (carte,
 * page Horaires, coupes automatiques). Le service le SIGNALE ; `VehiclesService` vide alors le
 * cache de l'instantané — sans quoi la carte ouverte juste après l'agenda mentirait 15 s.
 */
describe('VehicleEventsService — la disponibilité du véhicule est signalée (06/10/2026)', () => {
  const ligne = (type: string) => ({
    id: 'e1', fleetId: 'f1', vehicleId: 'v1', vehicle: { plate: 'AA-1' }, type, status: 'PLANNED',
    severity: null, title: 'Pneus', description: null, startAt: new Date(), endAt: null, allDay: true,
    blocksVehicle: true, odometerKm: null, planId: null, linkedEventId: null, resolvedAt: null,
    metadata: null, source: 'MANUAL', createdAt: new Date(), updatedAt: new Date(),
  });
  const admin = () => makeUser({ role: UserRole.FLEET_ADMIN });
  const signalements = (emit: jest.Mock) =>
    emit.mock.calls.filter((c) => c[0] === 'vehicule.disponibilite.modifiee').map((c) => c[1]);

  it('créer, modifier puis supprimer une maintenance : trois signalements, avec la société du véhicule', async () => {
    const prisma = makePrisma();
    const p = prisma as {
      vehicle: { findUnique: jest.Mock };
      vehicleEvent: { create: jest.Mock; findFirst: jest.Mock; update: jest.Mock; delete: jest.Mock };
    };
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'f1', lastOdometerAt: null });
    p.vehicleEvent.create.mockResolvedValue(ligne('MAINTENANCE'));
    p.vehicleEvent.findFirst.mockResolvedValue(ligne('MAINTENANCE'));
    p.vehicleEvent.update.mockResolvedValue(ligne('MAINTENANCE'));
    p.vehicleEvent.delete.mockResolvedValue({});
    const emitter = { emit: jest.fn() };
    const svc = new VehicleEventsService(prisma, access('ALL'), emitter as never);

    await svc.create(admin(), { vehicleId: 'v1', type: 'MAINTENANCE', title: 'Pneus', startAt: new Date().toISOString() });
    await svc.update(admin(), 'e1', { status: 'IN_PROGRESS' });
    await svc.remove(admin(), 'e1');

    expect(signalements(emitter.emit)).toEqual([
      { fleetId: 'f1', vehicleId: 'v1' },
      { fleetId: 'f1', vehicleId: 'v1' },
      { fleetId: 'f1', vehicleId: 'v1' },
    ]);
  });

  it('un incident signalé par le bouton dédié aussi', async () => {
    const prisma = makePrisma();
    const p = prisma as { vehicle: { findUnique: jest.Mock }; vehicleEvent: { create: jest.Mock } };
    p.vehicle.findUnique.mockResolvedValue({ id: 'v1', fleetId: 'f1' });
    p.vehicleEvent.create.mockResolvedValue({ ...ligne('INCIDENT'), status: 'OPEN' });
    const emitter = { emit: jest.fn() };
    const svc = new VehicleEventsService(prisma, access('ALL'), emitter as never);
    await svc.reportIncident(admin(), { vehicleId: 'v1', title: 'Roue crevée' });
    expect(signalements(emitter.emit)).toEqual([{ fleetId: 'f1', vehicleId: 'v1' }]);
  });
});
