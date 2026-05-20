import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TrackersService } from './trackers.service';

const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET = '00000000-0000-0000-0000-000000000099';
const TRACKER_ID = '00000000-0000-0000-0000-000000000010';
const VEHICLE_ID = '00000000-0000-0000-0000-000000000020';
const OTHER_TRACKER = '00000000-0000-0000-0000-000000000011';
const USER_ID = '00000000-0000-0000-0000-000000000030';

const fleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID };
const otherFleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: OTHER_FLEET };

const trackerRecord = (overrides: Record<string, unknown> = {}) => ({
  id: TRACKER_ID,
  imei: '123456789012345',
  model: 'COBAN_GPS403D',
  status: 'OFFLINE',
  lastSeenAt: null,
  vehicleId: null,
  vehicle: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

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

describe('TrackersService', () => {
  let service: TrackersService;
  let prisma: {
    // V1.10 (Sprint 6) — findFirst ajoute aux mocks car le service utilise
    // maintenant findFirst pour appliquer le filtre tenant via la relation
    // tracker.vehicle.fleetId. Idem pour vehicle (filtre tenant direct).
    tracker: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; delete: jest.Mock };
    vehicle: { findUnique: jest.Mock; findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      tracker: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(trackerRecord(data))),
        findMany: jest.fn().mockResolvedValue([trackerRecord()]),
        findUnique: jest.fn().mockResolvedValue(trackerRecord()),
        findFirst: jest.fn().mockResolvedValue(trackerRecord()),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve(trackerRecord({ ...data, vehicle: data.vehicleId ? vehicleRecord() : null })),
        ),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue(vehicleRecord()),
        findFirst: jest.fn().mockResolvedValue(vehicleRecord()),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        TrackersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(TrackersService);
  });

  // 1. create IMEI invalide (14 chiffres)
  it('should reject IMEI with 14 digits', async () => {
    await expect(
      service.create({ imei: '12345678901234' }, fleetAdmin),
    ).rejects.toThrow(BadRequestException);
  });

  // 2. create IMEI dupliqué
  it('should throw ConflictException on duplicate IMEI', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '6.0.0',
    });
    prisma.tracker.create.mockRejectedValue(p2002);

    await expect(
      service.create({ imei: '123456789012345' }, fleetAdmin),
    ).rejects.toThrow(ConflictException);
  });

  // 3. findAll filtre unassigned=true
  it('should filter unassigned trackers', async () => {
    await service.findAll(fleetAdmin, { unassigned: 'true' });
    expect(prisma.tracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ vehicleId: null }) }),
    );
  });

  // 4. remove refusé si tracker assigné
  it('should reject delete when tracker is assigned', async () => {
    // V1.10 (Sprint 6) — findOne utilise maintenant findFirst pour le filtre tenant.
    prisma.tracker.findFirst.mockResolvedValue(
      trackerRecord({ vehicleId: VEHICLE_ID, vehicle: vehicleRecord() }),
    );

    await expect(service.remove(TRACKER_ID, fleetAdmin)).rejects.toThrow(BadRequestException);
    await expect(service.remove(TRACKER_ID, fleetAdmin)).rejects.toThrow(
      'Détachez le tracker du véhicule avant suppression',
    );
  });

  // 5. assign tracker libre à véhicule libre → OK
  it('should assign free tracker to free vehicle', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerRecord());
    prisma.vehicle.findFirst.mockResolvedValue(vehicleRecord());

    const result = await service.assign(TRACKER_ID, VEHICLE_ID, fleetAdmin);
    expect(prisma.tracker.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { vehicleId: VEHICLE_ID } }),
    );
    expect(result).toBeDefined();
  });

  // 6. assign tracker déjà assigné → BadRequestException avec plaque
  it('should reject assign when tracker already assigned to another vehicle', async () => {
    prisma.tracker.findFirst.mockResolvedValue(
      trackerRecord({
        vehicleId: 'other-vehicle-id',
        vehicle: { id: 'other-vehicle-id', plate: 'ZZ-999-ZZ', fleetId: FLEET_ID },
      }),
    );
    prisma.vehicle.findFirst.mockResolvedValue(vehicleRecord());

    await expect(
      service.assign(TRACKER_ID, VEHICLE_ID, fleetAdmin),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.assign(TRACKER_ID, VEHICLE_ID, fleetAdmin),
    ).rejects.toThrow(/ZZ-999-ZZ/);
  });

  // 7. assign véhicule qui a déjà un tracker
  it('should reject assign when vehicle already has another tracker', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerRecord());
    prisma.vehicle.findFirst.mockResolvedValue(
      vehicleRecord({
        tracker: { id: OTHER_TRACKER, imei: '999888777666555' },
      }),
    );

    await expect(
      service.assign(TRACKER_ID, VEHICLE_ID, fleetAdmin),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.assign(TRACKER_ID, VEHICLE_ID, fleetAdmin),
    ).rejects.toThrow(/999888777666555/);
  });

  // 8. assign cross-fleet refusé (non-SUPER_ADMIN) → NotFoundException
  // V1.10 (Sprint 6) — le filtre fleetId integre au where rejette via findFirst
  // qui renvoie null. C'est NotFoundException (au lieu de 403 avant).
  it('should reject cross-fleet assign for non-SUPER_ADMIN', async () => {
    // Le vehicleWhere du service filtre par fleetId du caller (OTHER_FLEET pour
    // otherFleetAdmin). Le vehicle dans FLEET_ID ne match pas -> findFirst null.
    prisma.vehicle.findFirst.mockResolvedValue(null);

    await expect(
      service.assign(TRACKER_ID, VEHICLE_ID, otherFleetAdmin),
    ).rejects.toThrow(NotFoundException);
  });

  // 9. assign cross-fleet accepté (SUPER_ADMIN)
  it('should allow cross-fleet assign for SUPER_ADMIN', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerRecord());
    prisma.vehicle.findFirst.mockResolvedValue(vehicleRecord({ fleetId: OTHER_FLEET }));

    const crossFleetSuperAdmin = { ...superAdmin, fleetId: OTHER_FLEET };
    const result = await service.assign(TRACKER_ID, VEHICLE_ID, crossFleetSuperAdmin);
    expect(result).toBeDefined();
  });

  // 10. unassign d'un tracker non assigné → idempotent
  it('should be idempotent when unassigning an unassigned tracker', async () => {
    prisma.tracker.findFirst.mockResolvedValue(trackerRecord({ vehicleId: null }));

    const result = await service.unassign(TRACKER_ID, fleetAdmin);
    expect(result.vehicleId).toBeNull();
    expect(prisma.tracker.update).not.toHaveBeenCalled();
  });
});
