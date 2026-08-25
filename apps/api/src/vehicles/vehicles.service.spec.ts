import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CommandStatus, EngineAction, Prisma, UserRole } from '@prisma/client';
import { DORMANT_STOP_COUNTING_MS, MOVING_FRESHNESS_MS } from '@vizyo/tracky-shared';
import { InMemoryCacheService } from '../common/cache/in-memory-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { UnlockTokenService } from '../driver-unlock/unlock-token.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { GpsDeadZonesService } from '../gps-dead-zones/gps-dead-zones.service';
import { VehiclesService } from './vehicles.service';

const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET = '00000000-0000-0000-0000-000000000099';
const VEHICLE_ID = '00000000-0000-0000-0000-000000000020';
const USER_ID = '00000000-0000-0000-0000-000000000030';
const GROUP_ID = '00000000-0000-0000-0000-000000000040';

const fleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID };

const vehicleRecord = (overrides: Record<string, unknown> = {}) => ({
  id: VEHICLE_ID,
  fleetId: FLEET_ID,
  plate: 'AB-123-CD',
  brand: 'Renault',
  model: 'Master',
  year: 2022,
  color: null,
  tracker: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('VehiclesService', () => {
  let service: VehiclesService;
  let prisma: {
    // V1.10 (Sprint 6) — findFirst ajoute au mock car le service utilise
    // maintenant findFirst({where:{id, fleetId}}) au lieu de findUnique({id})
    // suivi de check fleetId, pour eviter l'IDOR cross-fleet.
    vehicle: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; delete: jest.Mock; count: jest.Mock };
    tracker: { update: jest.Mock };
    vehicleGroup: { findFirst: jest.Mock };
    vehicleGroupAssignment: { deleteMany: jest.Mock; create: jest.Mock };
    engineControlCommand: { findMany: jest.Mock };
    installationTask: { findFirst: jest.Mock; findMany: jest.Mock };
    // Lot « dénominateurs » — stats() compte (vehicle/alert), balaie la présence (findMany)
    // et lit les véhicules en mouvement en SQL brut.
    alert: { count: jest.Mock };
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      vehicle: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(vehicleRecord(data))),
        findMany: jest.fn().mockResolvedValue([vehicleRecord()]),
        findUnique: jest.fn().mockResolvedValue(vehicleRecord()),
        findFirst: jest.fn().mockResolvedValue(vehicleRecord()),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(vehicleRecord(data))),
        delete: jest.fn().mockResolvedValue(undefined),
        count: jest.fn().mockResolvedValue(0),
      },
      tracker: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      vehicleGroup: { findFirst: jest.fn().mockResolvedValue({ id: GROUP_ID }) },
      vehicleGroupAssignment: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ vehicleId: VEHICLE_ID, groupId: GROUP_ID }),
      },
      // Sprint 2 — snapshot() derive l'etat coupe TRI-ETAT depuis les commandes moteur.
      engineControlCommand: { findMany: jest.fn().mockResolvedValue([]) },
      // Sprint 10 — synchro véhicule ↔ planning : source = tâche d'installation liée.
      installationTask: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      alert: { count: jest.fn().mockResolvedValue(0) },
      // stats() interpole en template taggé : $queryRaw(strings, movingSince, ...). Le mock
      // reçoit donc les valeurs en arguments — c'est ce qui permet d'auditer le seuil utilisé.
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn().mockResolvedValue([]),
    };

    const module = await Test.createTestingModule({
      providers: [
        VehiclesService,
        { provide: PrismaService, useValue: prisma },
        // V1.10 (Sprint 6) — VehiclesService depend du cache pour les KPIs.
        // Mock minimal : passthrough (get retourne undefined -> miss -> compute).
        {
          provide: InMemoryCacheService,
          useValue: { get: jest.fn(), set: jest.fn(), invalidate: jest.fn(), wrap: jest.fn() },
        },
        // feat/comptes-conducteurs — VehiclesService injecte UnlockTokenService (génération QR).
        // Non exercé par ces tests (create/list/update/...) → mock minimal.
        {
          provide: UnlockTokenService,
          useValue: {
            buildDeepLink: jest.fn().mockReturnValue({ token: 't', url: 'u' }),
            signVehicleToken: jest.fn(),
            verifyVehicleToken: jest.fn(),
          },
        },
        // Journal des actions systeme : le service y trace les bascules « hors service ».
        // Non exerce par ces tests -> mock minimal (record est fire-and-forget).
        { provide: SystemActivityService, useValue: { record: jest.fn() } },
        // TRK-046 — présomption de stationnement : aucune zone par défaut, la dérivation
        // rend null et les DTO gardent leur forme d'avant.
        {
          provide: GpsDeadZonesService,
          useValue: {
            zonesParkingParVehicule: jest.fn().mockResolvedValue(new Map()),
            matchAmong: jest.fn().mockReturnValue(null),
          },
        },
      ],
    }).compile();

    service = module.get(VehiclesService);
  });

  // 1. create avec fleetId par défaut (non-SUPER_ADMIN)
  it('should create vehicle using requestedBy.fleetId for non-SUPER_ADMIN', async () => {
    const result = await service.create({ plate: 'AB-123-CD', brand: 'Renault' }, fleetAdmin);
    expect(prisma.vehicle.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fleetId: FLEET_ID }) }),
    );
    expect(result.plate).toBe('AB-123-CD');
  });

  // 2. create avec fleetId explicite refusé pour non-SUPER_ADMIN
  it('should reject explicit fleetId for non-SUPER_ADMIN', async () => {
    await expect(
      service.create({ plate: 'XY-999-ZZ', fleetId: OTHER_FLEET }, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
  });

  // 3. create plaque dupliquée → ConflictException
  it('should throw ConflictException on duplicate plate in same fleet', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '6.0.0',
    });
    prisma.vehicle.create.mockRejectedValue(p2002);

    await expect(
      service.create({ plate: 'AB-123-CD' }, fleetAdmin),
    ).rejects.toThrow(ConflictException);
  });

  // 4. create même plaque dans une autre fleet → OK (SUPER_ADMIN)
  it('should allow same plate in different fleet for SUPER_ADMIN', async () => {
    const result = await service.create(
      { plate: 'AB-123-CD', fleetId: OTHER_FLEET },
      superAdmin,
    );
    expect(prisma.vehicle.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fleetId: OTHER_FLEET }) }),
    );
    expect(result).toBeDefined();
  });

  // 5. findAll filtre par fleetId sauf SUPER_ADMIN
  it('should filter by fleetId for non-SUPER_ADMIN', async () => {
    await service.findAll(fleetAdmin);
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ fleetId: FLEET_ID }) }),
    );
  });

  // 6. findOne cross-fleet → NotFoundException
  // V1.10 (Sprint 6) — le service integre fleetId dans le where via findFirst.
  // Si le vehicule n'appartient pas a la flotte du caller, findFirst renvoie null
  // → NotFoundException (au lieu de 403 avant). C'est volontaire : ne pas leak
  // l'existence d'un vehicule cross-fleet via timing.
  it('should throw NotFoundException on cross-fleet findOne', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(null);

    await expect(service.findOne(VEHICLE_ID, fleetAdmin)).rejects.toThrow(NotFoundException);
  });

  // 7. update ne peut pas changer fleetId (non-SUPER_ADMIN)
  it('should reject fleetId change for non-SUPER_ADMIN', async () => {
    // update() utilise findOne() → findFirst() qui renvoie le default mock
    // (vehicleRecord avec FLEET_ID), donc le check fleetId-change kick in.
    await expect(
      service.update(VEHICLE_ID, { fleetId: OTHER_FLEET }, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
  });

  // 8. remove détache le tracker si présent
  it('should detach tracker before deleting vehicle', async () => {
    // remove() utilise findOne() qui passe par findFirst depuis Sprint 6.
    prisma.vehicle.findFirst.mockResolvedValue(
      vehicleRecord({ tracker: { id: 'tracker-1', imei: '111222333444555' } }),
    );

    await service.remove(VEHICLE_ID, fleetAdmin);

    expect(prisma.tracker.update).toHaveBeenCalledWith({
      where: { vehicleId: VEHICLE_ID },
      data: { vehicleId: null },
    });
    expect(prisma.vehicle.delete).toHaveBeenCalledWith({ where: { id: VEHICLE_ID } });
  });

  // 9. #28 — SUPER_ADMIN deplace un vehicule vers une autre flotte → detache le driver courant
  it('disconnects currentDriver when SUPER_ADMIN moves a vehicle to another fleet (#28)', async () => {
    // findOne -> findFirst renvoie le vehicule par defaut (fleetId=FLEET_ID).
    await service.update(VEHICLE_ID, { fleetId: OTHER_FLEET }, superAdmin);
    expect(prisma.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fleet: { connect: { id: OTHER_FLEET } },
          currentDriver: { disconnect: true },
        }),
      }),
    );
  });

  // --- Sprint 1 (Fondation Groupes) ---

  // 10. findOne aplatit le groupe (groups[0].group -> group) et retire `groups`.
  it('findOne exposes the vehicle group (flattened)', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(
      vehicleRecord({ groups: [{ group: { id: GROUP_ID, name: 'BOREAL' } }] }),
    );

    const result = await service.findOne(VEHICLE_ID, fleetAdmin);

    expect(result.group).toEqual({ id: GROUP_ID, name: 'BOREAL' });
    expect((result as Record<string, unknown>).groups).toBeUndefined();
  });

  // 11. findOne -> group null si aucune assignation.
  it('findOne returns group: null when the vehicle has no group', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(vehicleRecord({ groups: [] }));

    const result = await service.findOne(VEHICLE_ID, fleetAdmin);

    expect(result.group).toBeNull();
  });

  // 12. setGroup assigne (replace) un véhicule à un groupe de la même flotte.
  it('setGroup assigns the vehicle to a same-fleet group (replace)', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(vehicleRecord());
    prisma.vehicleGroup.findFirst.mockResolvedValue({ id: GROUP_ID });

    await service.setGroup(VEHICLE_ID, GROUP_ID, fleetAdmin);

    expect(prisma.vehicleGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: GROUP_ID, fleetId: FLEET_ID } }),
    );
    expect(prisma.vehicleGroupAssignment.deleteMany).toHaveBeenCalledWith({
      where: { vehicleId: VEHICLE_ID },
    });
    expect(prisma.vehicleGroupAssignment.create).toHaveBeenCalledWith({
      data: { vehicleId: VEHICLE_ID, groupId: GROUP_ID },
    });
  });

  // 13. setGroup(null) retire le véhicule de son groupe, sans recréer.
  it('setGroup removes the vehicle from its group when groupId is null', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(vehicleRecord());

    await service.setGroup(VEHICLE_ID, null, fleetAdmin);

    expect(prisma.vehicleGroup.findFirst).not.toHaveBeenCalled();
    expect(prisma.vehicleGroupAssignment.deleteMany).toHaveBeenCalledWith({
      where: { vehicleId: VEHICLE_ID },
    });
    expect(prisma.vehicleGroupAssignment.create).not.toHaveBeenCalled();
  });

  // 14. setGroup refuse un groupe d'une autre flotte (anti cross-fleet).
  it('setGroup rejects a group from another fleet', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(vehicleRecord());
    prisma.vehicleGroup.findFirst.mockResolvedValue(null);

    await expect(service.setGroup(VEHICLE_ID, GROUP_ID, fleetAdmin)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.vehicleGroupAssignment.deleteMany).not.toHaveBeenCalled();
  });

  // 15. setGroup sur un véhicule cross-fleet -> NotFound (IDOR, via findOne).
  it('setGroup throws NotFound on a cross-fleet vehicle (IDOR)', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(null);

    await expect(service.setGroup(VEHICLE_ID, GROUP_ID, fleetAdmin)).rejects.toThrow(
      NotFoundException,
    );
  });

  // Sprint 2 (revue #1/#2) — snapshot() expose un etat coupe TRI-ETAT par tracker.
  it('snapshot derives tri-state engineCutState (cut / pending / normal-after-RESTORE)', async () => {
    const A = 'tracker-a';
    const B = 'tracker-b';
    const C = 'tracker-c';
    const veh = (vid: string, tid: string) => ({
      id: vid,
      fleetId: FLEET_ID,
      plate: `AB-${vid}`,
      type: 'CAR',
      brand: 'Renault',
      model: 'Master',
      tracker: {
        id: tid,
        imei: `imei-${tid}`,
        status: 'OFFLINE',
        lastSeenAt: null,
        lastLat: null,
        lastLng: null,
        lastSpeedKmh: null,
        lastHeading: null,
        lastIgnition: null,
        lastValid: null,
        lastPositionAt: null,
        accConnected: null,
      },
      schedule: null,
      groups: [],
    });
    prisma.vehicle.findMany.mockResolvedValue([veh('a', A), veh('b', B), veh('c', C)]);

    const older = new Date(Date.now() - 60_000);
    const newer = new Date(Date.now() - 10_000);
    // findMany applique distinct ['trackerId','action'] : on fournit la derniere
    // commande par (tracker, action).
    prisma.engineControlCommand.findMany.mockResolvedValue([
      { trackerId: A, action: EngineAction.CUT, status: CommandStatus.ACKNOWLEDGED, createdAt: older },
      { trackerId: B, action: EngineAction.CUT, status: CommandStatus.SENT, createdAt: older },
      { trackerId: C, action: EngineAction.CUT, status: CommandStatus.ACKNOWLEDGED, createdAt: older },
      { trackerId: C, action: EngineAction.RESTORE, status: CommandStatus.SENT, createdAt: newer },
    ]);

    const snap = await service.snapshot(fleetAdmin);
    const byTracker = new Map(snap.map((s) => [s.trackerId, s]));

    // A : coupure confirmee -> 'cut'
    expect(byTracker.get(A)?.engineCutState).toBe('cut');
    expect(byTracker.get(A)?.engineCutActive).toBe(true);
    // B : coupure seulement envoyee (non confirmee par ignition) -> 'pending', PAS coupe
    expect(byTracker.get(B)?.engineCutState).toBe('pending');
    expect(byTracker.get(B)?.engineCutActive).toBe(false);
    // C : RESTORE plus recent qu'un CUT confirme -> 'normal' (revue #1 : sinon "coupe" colle a jamais)
    expect(byTracker.get(C)?.engineCutState).toBe('normal');
    expect(byTracker.get(C)?.engineCutActive).toBe(false);
  });

  // --- Sprint 10 (Synchro véhicule ↔ planning d'installation) ---

  const taskRecord = (overrides: Record<string, unknown> = {}) => ({
    id: 'task-1',
    planId: 'plan-1',
    vehicleId: VEHICLE_ID,
    brand: 'Peugeot',
    model: 'Expert',
    energy: 'DIESEL',
    scheduledDate: null,
    firstRegistrationDate: null,
    plan: { clientName: 'CDEF' },
    ...overrides,
  });

  // 16. capacityOverview scope par fleetId (non-super) + mappe la source planning + divergence.
  it('capacityOverview scopes by fleet and computes divergent fields vs the linked task', async () => {
    prisma.vehicle.findMany.mockResolvedValue([
      vehicleRecord({ brand: 'Renault', model: 'Master', energy: null, seats: null, childSeats: null, features: [], groups: [] }),
    ]);
    prisma.installationTask.findMany.mockResolvedValue([taskRecord()]); // brand/model/energy diffèrent

    const rows = await service.capacityOverview(fleetAdmin);

    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ fleetId: FLEET_ID }) }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].installationSource?.model).toBe('Expert');
    expect(rows[0].divergentFields.slice().sort()).toEqual(['brand', 'energy', 'model']);
  });

  // 17. syncFromInstallation recopie (écrase) les champs choisis non-vides depuis le planning.
  it('syncFromInstallation overwrites the chosen non-empty fields from the planning', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(vehicleRecord());
    prisma.installationTask.findFirst.mockResolvedValue(taskRecord());

    await service.syncFromInstallation(VEHICLE_ID, ['model', 'energy'], fleetAdmin);

    expect(prisma.vehicle.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: VEHICLE_ID }, data: { model: 'Expert', energy: 'DIESEL' } }),
    );
  });

  // 18. syncFromInstallation ne vide JAMAIS un champ : source vide -> rien à synchroniser -> BadRequest.
  it('syncFromInstallation never clears a field (empty planning value -> BadRequest, no update)', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(vehicleRecord());
    prisma.installationTask.findFirst.mockResolvedValue(taskRecord({ energy: null }));

    await expect(service.syncFromInstallation(VEHICLE_ID, ['energy'], fleetAdmin)).rejects.toThrow(BadRequestException);
    expect(prisma.vehicle.update).not.toHaveBeenCalled();
  });

  // 19. syncFromInstallation -> NotFound si aucune tâche d'installation liée.
  it('syncFromInstallation throws NotFound when no installation task is linked', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(vehicleRecord());
    prisma.installationTask.findFirst.mockResolvedValue(null);

    await expect(service.syncFromInstallation(VEHICLE_ID, ['model'], fleetAdmin)).rejects.toThrow(NotFoundException);
  });

  // 20. syncFromInstallation sur un véhicule cross-fleet -> NotFound (IDOR via findOne).
  it('syncFromInstallation throws NotFound on a cross-fleet vehicle (IDOR)', async () => {
    prisma.vehicle.findFirst.mockResolvedValue(null);

    await expect(service.syncFromInstallation(VEHICLE_ID, ['model'], fleetAdmin)).rejects.toThrow(NotFoundException);
    expect(prisma.installationTask.findFirst).not.toHaveBeenCalled();
  });

  // ─────────────────────── Lot « dénominateurs — flotte » (dormance, seuil 7 j) ───────────────────────
  //
  // Cas réel du 27/07 : 37 véhicules vivants, 2 muets (FV-941-LZ depuis 89 j, FL-787-KV depuis
  // 52 j) et 2 véhicules de test sans boîtier. Le dashboard affichait « 39 à l'arrêt », mettant
  // dans le même sac une camionnette garée pour la nuit et un boîtier arraché depuis trois mois.

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  /** Ligne du balayage de présence de `stats()` : un véhicule + (éventuellement) son boîtier. */
  const presence = (id: string, trackerId: string | null, lastSeenAt: Date | null) => ({
    id,
    tracker: trackerId ? { id: trackerId, lastSeenAt } : null,
  });

  describe('stats — partition explicite (roule / à l\'arrêt / injoignable)', () => {
    beforeEach(() => {
      // total = 4 (aucun filtre createdAt) ; newThisMonth = 0 (filtre createdAt présent).
      prisma.vehicle.count.mockImplementation(({ where }: { where?: Record<string, unknown> }) =>
        Promise.resolve(where?.createdAt ? 0 : 4),
      );
    });

    /** Parc de référence : 1 qui roule, 1 garé depuis 2 h, 1 muet depuis 89 j, 1 sans boîtier. */
    const parcReel = (silenceDuMuet = 89 * DAY) => [
      presence('v-roule', 'tr-roule', new Date(Date.now() - 30_000)),
      presence('v-gare', 'tr-gare', new Date(Date.now() - 2 * HOUR)),
      presence('v-muet', 'tr-muet', new Date(Date.now() - silenceDuMuet)),
      presence('v-sans-boitier', null, null),
    ];

    it('(a) un dormant sort de « à l\'arrêt » et est compté à part — la somme reste le total', async () => {
      prisma.vehicle.findMany.mockResolvedValue(parcReel());
      prisma.$queryRaw.mockResolvedValue([{ id: 'v-roule' }]);

      const res = await service.stats(fleetAdmin);

      expect(res.unreachable).toBe(1); // le muet depuis 89 j, nommé au lieu d'être noyé
      expect(res.moving).toBe(1);
      expect(res.idle).toBe(2); // le garé de 2 h + celui sans boîtier
      // Partition : aucun véhicule perdu, aucun compté deux fois. Le total ne baisse JAMAIS.
      expect(res.moving + res.idle + res.unreachable).toBe(res.total);
      expect(res.total).toBe(4);
      expect(res.dormantThresholdMs).toBe(DORMANT_STOP_COUNTING_MS);
      expect(res.presenceScanTruncated).toBe(false);
    });

    it('un balayage borné est SIGNALÉ, jamais subi (sinon le parc semblerait avoir rétréci)', async () => {
      // 4 véhicules en base, mais le balayage n'en a rendu que 2 (plafond VPS atteint) : la somme
      // des trois cases vaut 2 alors que le total en annonce 4. Ce genre d'écart doit être VISIBLE.
      prisma.vehicle.findMany.mockResolvedValue(parcReel().slice(0, 2));
      prisma.$queryRaw.mockResolvedValue([{ id: 'v-roule' }]);

      const res = await service.stats(fleetAdmin);

      expect(res.presenceScanTruncated).toBe(true);
      expect(res.total).toBe(4); // le total client ne baisse pas pour autant
      expect(res.moving + res.idle + res.unreachable).toBeLessThan(res.total);
    });

    it('(b) un véhicule silencieux 2 h reste « à l\'arrêt » (ce n\'est qu\'un stationnement)', async () => {
      prisma.vehicle.findMany.mockResolvedValue([presence('v-gare', 'tr-gare', new Date(Date.now() - 2 * HOUR))]);
      prisma.vehicle.count.mockResolvedValue(1);
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await service.stats(fleetAdmin);

      expect(res.unreachable).toBe(0);
      expect(res.idle).toBe(1);
    });

    it('(b bis) un week-end + pont (6 j de silence) ne bascule pas encore en injoignable', async () => {
      prisma.vehicle.findMany.mockResolvedValue([presence('v-pont', 'tr-pont', new Date(Date.now() - 6 * DAY))]);
      prisma.vehicle.count.mockResolvedValue(1);
      prisma.$queryRaw.mockResolvedValue([]);

      expect((await service.stats(fleetAdmin)).unreachable).toBe(0);
    });

    it('(c) un véhicule SANS boîtier n\'est pas injoignable — il n\'a jamais parlé, il ne s\'est pas tu', async () => {
      prisma.vehicle.findMany.mockResolvedValue([
        presence('v-sans-boitier', null, null),
        // Boîtier posé mais jamais provisionné (SIM/APN KO) : même raisonnement.
        presence('v-jamais-emis', 'tr-neuf', null),
      ]);
      prisma.vehicle.count.mockResolvedValue(2);
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await service.stats(fleetAdmin);

      expect(res.unreachable).toBe(0);
      expect(res.idle).toBe(2); // ils restent des membres légitimes du parc
    });

    it('(d) réintégration : dès que le boîtier ré-émet, le véhicule quitte les injoignables tout seul', async () => {
      prisma.vehicle.findMany.mockResolvedValue(parcReel());
      prisma.$queryRaw.mockResolvedValue([{ id: 'v-roule' }]);
      expect((await service.stats(fleetAdmin)).unreachable).toBe(1);

      // Une seule trame reçue suffit : aucun drapeau à lever, aucune action manuelle.
      prisma.vehicle.findMany.mockResolvedValue(parcReel(45 * MIN));
      const apres = await service.stats(fleetAdmin);

      expect(apres.unreachable).toBe(0);
      expect(apres.idle).toBe(3);
    });

    it('la fraîcheur « en mouvement » vient du partage (5 min), plus d\'un seuil réinventé ici', async () => {
      prisma.vehicle.findMany.mockResolvedValue([]);
      prisma.$queryRaw.mockResolvedValue([]);
      const avant = Date.now();

      await service.stats(fleetAdmin);

      // 1er argument interpolé du template taggé = la borne de fraîcheur des positions.
      const movingSince = prisma.$queryRaw.mock.calls[0]![1] as Date;
      expect(movingSince).toBeInstanceOf(Date);
      const applique = avant - movingSince.getTime();
      expect(applique).toBeGreaterThanOrEqual(MOVING_FRESHNESS_MS - 50);
      expect(applique).toBeLessThanOrEqual(MOVING_FRESHNESS_MS + 2000);
    });

    it('le balayage de présence reste scopé à la flotte de l\'appelant (pas de fuite cross-tenant)', async () => {
      prisma.vehicle.findMany.mockResolvedValue([]);
      prisma.$queryRaw.mockResolvedValue([]);

      await service.stats(fleetAdmin);

      expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ fleetId: FLEET_ID }) }),
      );
    });
  });

  describe('capacityOverview — le muet est SIGNALÉ, jamais retiré', () => {
    const capacityRow = (id: string, trackerId: string | null, lastSeenAt: Date | null) =>
      vehicleRecord({
        id,
        plate: id,
        features: [],
        groups: [],
        tracker: trackerId ? { id: trackerId, lastSeenAt } : null,
      });

    it('(a) un boîtier muet depuis 89 j est marqué dormant, avec son ancienneté — et reste dans le tableau', async () => {
      prisma.vehicle.findMany.mockResolvedValue([capacityRow('FV-941-LZ', 'tr-muet', new Date(Date.now() - 89 * DAY))]);

      const rows = await service.capacityOverview(fleetAdmin);

      expect(rows).toHaveLength(1); // la capacité du véhicule reste consultable
      expect(rows[0]!.dormant).toBe(true);
      expect(rows[0]!.silenceLabel).toBe('89 j');
      expect(rows[0]!.lastSeenAt).not.toBeNull();
    });

    it('(b) un véhicule silencieux 2 h n\'est pas dormant', async () => {
      prisma.vehicle.findMany.mockResolvedValue([capacityRow('AB-123-CD', 'tr-gare', new Date(Date.now() - 2 * HOUR))]);

      const rows = await service.capacityOverview(fleetAdmin);

      expect(rows[0]!.dormant).toBe(false);
      expect(rows[0]!.silenceLabel).toBe('2 h');
    });

    it('(c) un véhicule SANS boîtier n\'est pas dormant et garde toute sa capacité', async () => {
      prisma.vehicle.findMany.mockResolvedValue([capacityRow('TEST-001-XX', null, null)]);

      const rows = await service.capacityOverview(fleetAdmin);

      expect(rows[0]!.dormant).toBe(false);
      expect(rows[0]!.lastSeenAt).toBeNull();
      expect(rows[0]!.silenceLabel).toBeNull();
    });

    it('(d) réintégration : un lastSeenAt frais suffit à retirer la pastille', async () => {
      prisma.vehicle.findMany.mockResolvedValue([capacityRow('FV-941-LZ', 'tr-muet', new Date(Date.now() - 89 * DAY))]);
      expect((await service.capacityOverview(fleetAdmin))[0]!.dormant).toBe(true);

      prisma.vehicle.findMany.mockResolvedValue([capacityRow('FV-941-LZ', 'tr-muet', new Date(Date.now() - 30_000))]);
      expect((await service.capacityOverview(fleetAdmin))[0]!.dormant).toBe(false);
    });
  });
});
