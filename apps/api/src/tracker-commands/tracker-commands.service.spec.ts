import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TrackerCommandStatus, UserRole } from '@prisma/client';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { AckWaiterService } from './ack-waiter.service';
import { TrackerCommandsService } from './tracker-commands.service';

const TRACKER_ID = '00000000-0000-0000-0000-000000000010';
const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET_ID = '00000000-0000-0000-0000-000000000099';
const USER_ID = '00000000-0000-0000-0000-000000000030';

const trackerWithVehicle = {
  id: TRACKER_ID,
  imei: '123456789012345',
  model: 'COBAN_GPS403D',
  status: 'ONLINE',
  vehicleId: 'v-1',
  vehicle: { id: 'v-1', fleetId: FLEET_ID, plate: 'AB-123-CD' },
};

const trackerWithoutVehicle = { ...trackerWithVehicle, vehicleId: null, vehicle: null };

const fleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID };
const otherFleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: OTHER_FLEET_ID };

let commandCounter = 0;
function mockCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: `cmd-${++commandCounter}`,
    trackerId: TRACKER_ID,
    templateId: 'status',
    category: 'info',
    params: {},
    payload: '**,imei:123456789012345,B;',
    channel: 'TCP',
    status: TrackerCommandStatus.PENDING,
    scheduledAt: null,
    sentAt: null,
    ackedAt: null,
    ackResponse: null,
    lastError: null,
    requestedBy: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('TrackerCommandsService', () => {
  let service: TrackerCommandsService;
  let prisma: {
    tracker: { findUnique: jest.Mock };
    trackerCommand: { create: jest.Mock; update: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
  };
  let registry: { send: jest.Mock };
  let ackWaiter: { waitForAck: jest.Mock };
  let wireLog: { out: jest.Mock; ackMatch: jest.Mock; ackTimeout: jest.Mock };

  beforeEach(async () => {
    commandCounter = 0;
    prisma = {
      tracker: { findUnique: jest.fn() },
      trackerCommand: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(mockCommand(data))),
        update: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    registry = { send: jest.fn().mockReturnValue(false) };
    ackWaiter = { waitForAck: jest.fn().mockReturnValue(new Promise(() => {})) };
    wireLog = { out: jest.fn(), ackMatch: jest.fn(), ackTimeout: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        TrackerCommandsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SocketRegistryService, useValue: registry },
        { provide: AckWaiterService, useValue: ackWaiter },
        { provide: CobanWireLogger, useValue: wireLog },
        { provide: RealtimeGateway, useValue: { server: { to: jest.fn().mockReturnThis(), emit: jest.fn() } } },
      ],
    }).compile();

    service = module.get(TrackerCommandsService);
  });

  it('should reject engine_stop with 400', async () => {
    await expect(
      service.request(TRACKER_ID, 'engine_stop', {}, null, fleetAdmin),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject engine_resume with 400', async () => {
    await expect(
      service.request(TRACKER_ID, 'engine_resume', {}, null, fleetAdmin),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject unknown template', async () => {
    await expect(
      service.request(TRACKER_ID, 'nonexistent', {}, null, fleetAdmin),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject super-admin-only template for non-super-admin', async () => {
    await expect(
      service.request(TRACKER_ID, 'factory', {}, null, fleetAdmin),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should reject when tracker not found', async () => {
    prisma.tracker.findUnique.mockResolvedValue(null);
    await expect(
      service.request(TRACKER_ID, 'status', {}, null, fleetAdmin),
    ).rejects.toThrow(NotFoundException);
  });

  it('should reject when tracker has no vehicle', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithoutVehicle);
    await expect(
      service.request(TRACKER_ID, 'status', {}, null, fleetAdmin),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject fleet mismatch for non-super-admin', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    await expect(
      service.request(TRACKER_ID, 'status', {}, null, otherFleetAdmin),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should create PENDING command and dispatch', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    registry.send.mockReturnValue(true);

    const result = await service.request(TRACKER_ID, 'status', {}, null, fleetAdmin);
    expect(result.status).toBe(TrackerCommandStatus.PENDING);
    expect(result.payload).toContain('**,imei:123456789012345,B;');
    expect(registry.send).toHaveBeenCalledWith('123456789012345', expect.stringContaining('imei:123456789012345'));
  });

  it('should create SCHEDULED command without dispatch', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    const future = new Date(Date.now() + 3600_000);

    const result = await service.request(TRACKER_ID, 'status', {}, future, fleetAdmin);
    expect(result.status).toBe(TrackerCommandStatus.SCHEDULED);
    expect(registry.send).not.toHaveBeenCalled();
  });

  it('should fail dispatch when tracker offline', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    registry.send.mockReturnValue(false);

    await expect(
      service.request(TRACKER_ID, 'status', {}, null, fleetAdmin),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('should allow SUPER_ADMIN to use factory template', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    registry.send.mockReturnValue(false);

    await expect(
      service.request(TRACKER_ID, 'factory', {}, null, superAdmin),
    ).rejects.toThrow(ServiceUnavailableException); // fails at dispatch, not at permission
  });

  it('should validate required params', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    await expect(
      service.request(TRACKER_ID, 'speed_alarm', {}, null, fleetAdmin),
    ).rejects.toThrow(BadRequestException);
  });

  it('should build payload with params', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    registry.send.mockReturnValue(true);

    const result = await service.request(
      TRACKER_ID, 'speed_alarm', { speed_kmh: 80 }, null, fleetAdmin,
    );
    expect(result.payload).toBe('speed123456 080');
  });

  it('should cancel SCHEDULED command', async () => {
    prisma.trackerCommand.findUnique.mockResolvedValue(
      mockCommand({ status: TrackerCommandStatus.SCHEDULED, tracker: trackerWithVehicle }),
    );
    prisma.trackerCommand.update.mockResolvedValue(
      mockCommand({ status: TrackerCommandStatus.CANCELLED }),
    );

    const result = await service.cancel('cmd-1', fleetAdmin);
    expect(result.status).toBe(TrackerCommandStatus.CANCELLED);
  });

  it('should reject cancel of SENT command', async () => {
    prisma.trackerCommand.findUnique.mockResolvedValue(
      mockCommand({ status: TrackerCommandStatus.SENT, tracker: trackerWithVehicle }),
    );

    await expect(service.cancel('cmd-1', fleetAdmin)).rejects.toThrow(BadRequestException);
  });

  it('should return catalog filtered by role', () => {
    const adminCatalog = service.getCatalog(UserRole.FLEET_ADMIN);
    const superCatalog = service.getCatalog(UserRole.SUPER_ADMIN);
    expect(superCatalog.length).toBeGreaterThan(adminCatalog.length);
    expect(adminCatalog.find((t: any) => t.id === 'factory')).toBeUndefined();
    expect(superCatalog.find((t: any) => t.id === 'factory')).toBeDefined();
  });

  it('should start ACK waiter after dispatch', async () => {
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    registry.send.mockReturnValue(true);

    await service.request(TRACKER_ID, 'status', {}, null, fleetAdmin);
    expect(ackWaiter.waitForAck).toHaveBeenCalledWith(
      '123456789012345',
      expect.any(RegExp),
      expect.any(Number),
      expect.any(String),
    );
  });

  it('should compute a real ACK latency from the captured sentAt, not 0 (#36)', async () => {
    jest.useFakeTimers();
    prisma.tracker.findUnique.mockResolvedValue(trackerWithVehicle);
    registry.send.mockReturnValue(true);
    let resolveAck!: (s: string) => void;
    ackWaiter.waitForAck.mockReturnValue(
      new Promise<string>((res) => {
        resolveAck = res;
      }),
    );

    await service.request(TRACKER_ID, 'status', {}, null, fleetAdmin);

    // 1,5 s s'ecoulent avant l'arrivee de l'ACK.
    jest.setSystemTime(Date.now() + 1500);
    resolveAck('imei:123456789012345,B ok');
    await Promise.resolve();
    await Promise.resolve();

    expect(wireLog.ackMatch).toHaveBeenCalledWith(
      '123456789012345',
      'imei:123456789012345,B ok',
      expect.any(String),
      1500,
    );
    jest.useRealTimers();
  });
});
