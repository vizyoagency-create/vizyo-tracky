import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CommandStatus, EngineAction, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { EngineControlService } from './engine-control.service';

const TRACKER_ID = '00000000-0000-0000-0000-000000000010';
const VEHICLE_ID = '00000000-0000-0000-0000-000000000020';
const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET_ID = '00000000-0000-0000-0000-000000000099';
const USER_ID = '00000000-0000-0000-0000-000000000030';

const trackerWithVehicle = {
  id: TRACKER_ID,
  imei: '123456789012345',
  model: 'COBAN_GPS403D',
  status: 'OFFLINE',
  vehicleId: VEHICLE_ID,
  vehicle: {
    id: VEHICLE_ID,
    fleetId: FLEET_ID,
    plate: 'AB-123-CD',
    fleet: { id: FLEET_ID, name: 'Test Fleet' },
  },
};

const trackerWithoutVehicle = {
  ...trackerWithVehicle,
  vehicleId: null,
  vehicle: null,
};

function recentPosition(speedKmh: number, ageMs = 0, valid = true) {
  return {
    id: '00000000-0000-0000-0000-000000000040',
    trackerId: TRACKER_ID,
    lat: 33.5,
    lng: -7.6,
    speedKmh,
    heading: 0,
    altitude: null,
    satellites: null,
    valid,
    timestamp: new Date(Date.now() - ageMs),
    createdAt: new Date(),
  };
}

const createdCommand = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-0000-0000-000000000050',
  trackerId: TRACKER_ID,
  action: EngineAction.CUT,
  status: CommandStatus.PENDING,
  reason: null,
  requestedBy: USER_ID,
  lastError: null,
  scheduledAt: null,
  sentAt: null,
  ackedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const fleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID };
const otherFleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: OTHER_FLEET_ID };

describe('EngineControlService', () => {
  let service: EngineControlService;
  let prisma: {
    tracker: { findUnique: jest.Mock };
    position: { findFirst: jest.Mock };
    engineControlCommand: { create: jest.Mock; update: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock };
  };
  let registry: { get: jest.Mock };

  beforeEach(async () => {
    prisma = {
      tracker: { findUnique: jest.fn() },
      position: { findFirst: jest.fn() },
      engineControlCommand: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(createdCommand(data))),
        update: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
      },
    };

    registry = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        EngineControlService,
        { provide: PrismaService, useValue: prisma },
        { provide: SocketRegistryService, useValue: registry },
      ],
    }).compile();

    service = module.get(EngineControlService);
  });

  // 1. CUT refusé si tracker introuvable
  it('should throw NotFoundException when tracker does not exist', async () => {
    prisma.tracker.findUnique.mockResolvedValue(null);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(NotFoundException);
  });

  // 2. CUT refusé si tracker sans vehicle
  it('should throw BadRequestException when tracker has no vehicle', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithoutVehicle);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(BadRequestException);
  });

  // 3. CUT refusé si fleetId différent et pas SUPER_ADMIN
  it('should throw ForbiddenException when fleet mismatch for non-SUPER_ADMIN', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, otherFleetAdmin),
    ).rejects.toThrow(ForbiddenException);
  });

  // 4. CUT refusé si aucune position → REJECTED_SPEED persistée
  it('should reject CUT and persist REJECTED_SPEED when no position exists', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(null);
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: CommandStatus.REJECTED_SPEED,
        lastError: 'Aucune position connue pour ce tracker',
      }),
    });
  });

  // 5. CUT refusé si position > 60s (stale)
  it('should reject CUT when position is stale (>60s)', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(5, 90 * 1000));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: CommandStatus.REJECTED_SPEED,
        lastError: 'Position trop ancienne (stale)',
      }),
    });
  });

  // 6. CUT refusé si fix GPS invalide
  it('should reject CUT when GPS fix is invalid', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(5, 0, false));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: CommandStatus.REJECTED_SPEED,
        lastError: 'Fix GPS invalide',
      }),
    });
  });

  // 7. CUT refusé si speedKmh === 21
  it('should reject CUT when speed is 21 km/h', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(21));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: CommandStatus.REJECTED_SPEED,
        lastError: 'Vitesse trop élevée : 21 km/h',
      }),
    });
  });

  // 8. CUT refusé si speedKmh === 20.01
  it('should reject CUT when speed is 20.01 km/h', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(20.01));
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
  });

  // 9. CUT ACCEPTÉ si speedKmh === 20.0 → PENDING puis 503 (tracker offline)
  it('should accept CUT at 20.0 km/h then fail dispatch (offline)', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(20.0));
    registry.get.mockReturnValue(undefined);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING }),
    });
    expect(prisma.engineControlCommand.update).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
      data: expect.objectContaining({ status: CommandStatus.FAILED }),
    });
  });

  // 10. CUT ACCEPTÉ + dispatch réussi si tracker connecté
  it('should dispatch CUT to connected tracker', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(0));
    const mockSocket = { write: jest.fn() };
    registry.get.mockReturnValue({ socket: mockSocket });

    const result = await service.requestCommand(TRACKER_ID, EngineAction.CUT, null, fleetAdmin);

    expect(result.status).toBe(CommandStatus.PENDING);
    expect(mockSocket.write).toHaveBeenCalledWith(
      expect.stringContaining('**,imei:123456789012345,J;'),
    );
    expect(prisma.engineControlCommand.update).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
      data: expect.objectContaining({ status: CommandStatus.SENT }),
    });
  });

  // 11. SUPER_ADMIN peut CUT sur une autre flotte
  it('should allow SUPER_ADMIN to CUT on any fleet', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(recentPosition(5));
    registry.get.mockReturnValue(undefined);

    const crossFleetSuperAdmin = { ...superAdmin, fleetId: OTHER_FLEET_ID };
    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.CUT, null, crossFleetSuperAdmin),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  // 12. RESTORE accepté même avec speed = 100
  it('should allow RESTORE even when speed is 100 km/h', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    registry.get.mockReturnValue(undefined);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.engineControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: CommandStatus.PENDING, action: EngineAction.RESTORE }),
    });
  });

  // 13. RESTORE accepté même sans aucune position
  it('should allow RESTORE even when no position exists', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    prisma.position.findFirst.mockResolvedValue(null);
    registry.get.mockReturnValue(undefined);

    await expect(
      service.requestCommand(TRACKER_ID, EngineAction.RESTORE, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(prisma.position.findFirst).not.toHaveBeenCalled();
  });
});
