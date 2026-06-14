import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, UserRole } from '@prisma/client';
import { InMemoryCacheService } from '../common/cache/in-memory-cache.service';
import { PrismaService } from '../prisma/prisma.service';
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
    vehicle: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; delete: jest.Mock };
    tracker: { update: jest.Mock };
    vehicleGroup: { findFirst: jest.Mock };
    vehicleGroupAssignment: { deleteMany: jest.Mock; create: jest.Mock };
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
      },
      tracker: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      vehicleGroup: { findFirst: jest.fn().mockResolvedValue({ id: GROUP_ID }) },
      vehicleGroupAssignment: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ vehicleId: VEHICLE_ID, groupId: GROUP_ID }),
      },
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
});
