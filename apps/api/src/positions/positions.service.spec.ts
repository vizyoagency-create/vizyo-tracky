import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PositionsService } from './positions.service';

const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET = '00000000-0000-0000-0000-000000000099';
const TRACKER_ID = '00000000-0000-0000-0000-000000000010';
const VEHICLE_ID = '00000000-0000-0000-0000-000000000020';

const admin = { role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { role: UserRole.SUPER_ADMIN, fleetId: FLEET_ID };
const otherAdmin = { role: UserRole.FLEET_ADMIN, fleetId: OTHER_FLEET };

const posRecord = (i: number) => ({
  id: `pos-${i}`,
  trackerId: TRACKER_ID,
  lat: 33.5,
  lng: -7.5,
  speedKmh: 10 * i,
  heading: 0,
  altitude: null,
  satellites: null,
  valid: true,
  timestamp: new Date(Date.now() - i * 1000),
  createdAt: new Date(),
});

describe('PositionsService.list', () => {
  let service: PositionsService;
  let prisma: {
    vehicle: { findUnique: jest.Mock };
    tracker: { findUnique: jest.Mock; update: jest.Mock };
    position: { findMany: jest.Mock; create: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      vehicle: { findUnique: jest.fn() },
      tracker: {
        findUnique: jest.fn().mockResolvedValue({
          id: TRACKER_ID,
          vehicle: { id: VEHICLE_ID, fleetId: FLEET_ID },
        }),
        update: jest.fn(),
      },
      position: {
        findMany: jest.fn().mockResolvedValue([posRecord(1), posRecord(2), posRecord(3)]),
        create: jest.fn(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        PositionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeGateway, useValue: { broadcastPosition: jest.fn() } },
      ],
    }).compile();

    service = module.get(PositionsService);
  });

  it('should list positions by trackerId', async () => {
    const result = await service.list(admin, { trackerId: TRACKER_ID });
    expect(result.items).toHaveLength(3);
    expect(prisma.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { trackerId: TRACKER_ID } }),
    );
  });

  it('should resolve trackerId from vehicleId', async () => {
    prisma.vehicle.findUnique.mockResolvedValue({
      id: VEHICLE_ID,
      fleetId: FLEET_ID,
      tracker: { id: TRACKER_ID },
    });
    const result = await service.list(admin, { vehicleId: VEHICLE_ID });
    expect(result.items).toHaveLength(3);
  });

  it('should reject cross-fleet access', async () => {
    await expect(service.list(otherAdmin, { trackerId: TRACKER_ID }))
      .rejects.toThrow(ForbiddenException);
  });

  it('should throw BadRequest when no trackerId or vehicleId', async () => {
    await expect(service.list(admin, {}))
      .rejects.toThrow(BadRequestException);
  });

  it('should apply time filters', async () => {
    const from = '2026-01-01T00:00:00Z';
    const to = '2026-12-31T23:59:59Z';
    await service.list(admin, { trackerId: TRACKER_ID, from, to });
    expect(prisma.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          timestamp: { gte: new Date(from), lte: new Date(to) },
        }),
      }),
    );
  });
});
