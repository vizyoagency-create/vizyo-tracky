import { UserRole } from '@prisma/client';
import { TrackerCommandsService } from '../tracker-commands/tracker-commands.service';
import { TrackersService } from '../trackers/trackers.service';
import { VehicleGroupsController } from '../vehicle-groups/vehicle-groups.controller';
import { VehiclesService } from '../vehicles/vehicles.service';
import { resolveTenantScope } from './tenant-scope';

/**
 * Audit A3/B1/B2/D9 — fail-closed du périmètre tenant.
 * Prouve que (1) le helper décide correctement et (2) chaque endpoint patché
 * renvoie VIDE (sans requête « toutes flottes ») pour un non-super à fleetId
 * null, et filtre sur la flotte de l'utilisateur dans le cas normal.
 */

const FLEET_A = '00000000-0000-0000-0000-00000000000a';
const denyUser = { userId: 'u', role: UserRole.FLEET_ADMIN, fleetId: null };
const fleetUser = { userId: 'u', role: UserRole.FLEET_ADMIN, fleetId: FLEET_A };

describe('resolveTenantScope', () => {
  it('SUPER_ADMIN → ALL (aucune restriction)', () => {
    expect(resolveTenantScope({ role: UserRole.SUPER_ADMIN, fleetId: null })).toEqual({
      mode: 'ALL',
    });
  });

  it('non-super avec fleetId → FLEET', () => {
    expect(resolveTenantScope({ role: UserRole.FLEET_ADMIN, fleetId: FLEET_A })).toEqual({
      mode: 'FLEET',
      fleetId: FLEET_A,
    });
    expect(resolveTenantScope({ role: UserRole.VIEWER, fleetId: FLEET_A })).toEqual({
      mode: 'FLEET',
      fleetId: FLEET_A,
    });
  });

  it('non-super sans fleetId (null/undefined) → DENY', () => {
    expect(resolveTenantScope({ role: UserRole.FLEET_ADMIN, fleetId: null })).toEqual({
      mode: 'DENY',
    });
    expect(resolveTenantScope({ role: UserRole.FLEET_MANAGER, fleetId: undefined })).toEqual({
      mode: 'DENY',
    });
    expect(resolveTenantScope({ role: UserRole.VIEWER, fleetId: null })).toEqual({ mode: 'DENY' });
  });
});

describe('fail-closed endpoints (audit A3/B1/B2/D9)', () => {
  const cache = { get: jest.fn().mockReturnValue(undefined), set: jest.fn() };

  describe('VehiclesService', () => {
    const make = (prisma: unknown) => new VehiclesService(prisma as never, cache as never);

    it('findAll: non-super sans fleetId → [] et aucune requête DB', async () => {
      const prisma = { vehicle: { findMany: jest.fn() } };
      expect(await make(prisma).findAll(denyUser as never)).toEqual([]);
      expect(prisma.vehicle.findMany).not.toHaveBeenCalled();
    });

    it('findAll: utilisateur normal → where.fleetId = sa flotte', async () => {
      const prisma = { vehicle: { findMany: jest.fn().mockResolvedValue([]) } };
      await make(prisma).findAll(fleetUser as never);
      expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ fleetId: FLEET_A }) }),
      );
    });

    it('stats: non-super sans fleetId → zéros et aucune requête DB', async () => {
      const prisma = { vehicle: { count: jest.fn() }, alert: { count: jest.fn() }, $queryRaw: jest.fn() };
      expect(await make(prisma).stats(denyUser as never)).toEqual({
        total: 0,
        moving: 0,
        idle: 0,
        criticalAlerts: 0,
        newThisMonth: 0,
      });
      expect(prisma.vehicle.count).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.alert.count).not.toHaveBeenCalled();
    });

    it('snapshot: non-super sans fleetId → [] et aucune requête DB', async () => {
      const prisma = { vehicle: { findMany: jest.fn() } };
      expect(await make(prisma).snapshot(denyUser as never)).toEqual([]);
      expect(prisma.vehicle.findMany).not.toHaveBeenCalled();
    });
  });

  describe('VehicleGroupsController', () => {
    it('findAll: non-super sans fleetId → [] et aucune requête DB', async () => {
      const prisma = { vehicleGroup: { findMany: jest.fn() } };
      const ctrl = new VehicleGroupsController(prisma as never);
      expect(await ctrl.findAll({ user: denyUser } as never)).toEqual([]);
      expect(prisma.vehicleGroup.findMany).not.toHaveBeenCalled();
    });

    it('findAll: utilisateur normal → where.fleetId', async () => {
      const prisma = { vehicleGroup: { findMany: jest.fn().mockResolvedValue([]) } };
      const ctrl = new VehicleGroupsController(prisma as never);
      await ctrl.findAll({ user: fleetUser } as never);
      expect(prisma.vehicleGroup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { fleetId: FLEET_A } }),
      );
    });
  });

  describe('TrackersService', () => {
    const make = (prisma: unknown) =>
      new TrackersService(prisma as never, { emit: jest.fn() } as never);

    it('findAll: non-super sans fleetId → [] et aucune requête DB', async () => {
      const prisma = { tracker: { findMany: jest.fn() } };
      expect(await make(prisma).findAll(denyUser as never)).toEqual([]);
      expect(prisma.tracker.findMany).not.toHaveBeenCalled();
    });

    it('findAll: utilisateur normal → where.vehicle.fleetId', async () => {
      const prisma = { tracker: { findMany: jest.fn().mockResolvedValue([]) } };
      await make(prisma).findAll(fleetUser as never);
      expect(prisma.tracker.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ vehicle: { fleetId: FLEET_A } }) }),
      );
    });
  });

  describe('TrackerCommandsService', () => {
    const make = (prisma: unknown) =>
      new TrackerCommandsService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { record: jest.fn() } as never,
      );

    it('list: non-super sans fleetId → [] et aucune requête DB', async () => {
      const prisma = { trackerCommand: { findMany: jest.fn() } };
      expect(await make(prisma).list(denyUser as never)).toEqual([]);
      expect(prisma.trackerCommand.findMany).not.toHaveBeenCalled();
    });

    it('list: utilisateur normal → where.tracker.vehicle.fleetId', async () => {
      const prisma = { trackerCommand: { findMany: jest.fn().mockResolvedValue([]) } };
      await make(prisma).list(fleetUser as never);
      expect(prisma.trackerCommand.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tracker: { vehicle: { fleetId: FLEET_A } } }),
        }),
      );
    });
  });
});
