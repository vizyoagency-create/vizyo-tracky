import 'reflect-metadata';
import { ForbiddenException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessType, UserRole } from '@prisma/client';
import type { UserPermissions } from '@vizyo/tracky-shared';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { VEHICLE_PERMISSIONS_KEY } from '../auth/decorators/vehicle-permissions.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { AuthUser } from '../auth/types/auth-user';
import { DriversService } from '../drivers/drivers.service';
import type { ErrorLogger } from '../observability/error-logger.service';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import type { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { VehiclesController } from './vehicles.controller';
import type { VehiclesService } from './vehicles.service';

/**
 * Revue du 29/09 — `PATCH /vehicles/:id/driver` borné au véhicule visé, comme les écritures
 * véhicule (T9).
 *
 * Avant : `@RequirePermissions('drivers_manage')` résolvait l'UNION des scopes, et
 * `DriversService.assignToVehicle` ne filtrait que la société. Un gestionnaire qui avait
 * `drivers_manage` sur UN véhicule assignait un conducteur à n'importe quel véhicule de sa société.
 *
 * Ces tests passent par la VRAIE garde, le VRAI résolveur et les métadonnées RÉELLEMENT posées
 * sur `VehiclesController.assignDriver` : retirer le décorateur les fait échouer.
 */

const FLEET = 'fleet-1';
const V_OK = 'veh-a'; // ligne d'accès VEHICLE, drivers_manage accordé
const V_REFUSE = 'veh-b'; // ligne d'accès VEHICLE, drivers_manage refusé (vue seule)
const V_HORS = 'veh-c'; // même société, aucune ligne d'accès → hors périmètre
const DRIVER = { id: 'drv-1', fleetId: FLEET, isActive: true };

function makeUser(role: UserRole): AuthUser {
  return {
    id: `user-${role}`,
    authUserId: `auth-${role}`,
    email: 'u@test.fr',
    firstName: null,
    lastName: null,
    role,
    fleetId: FLEET,
    isActive: true,
    isOwner: false,
    permissions: null,
  };
}

interface AccessRow {
  accessType: AccessType;
  vehicleId: string | null;
  permissions: Partial<UserPermissions> | null;
}

/** Lignes d'accès du gestionnaire : `drivers_manage` sur UN véhicule, vue seule sur un autre. */
const MANAGER_ROWS: AccessRow[] = [
  { accessType: AccessType.VEHICLE, vehicleId: V_OK, permissions: { vehicles_view: true, drivers_manage: true } },
  { accessType: AccessType.VEHICLE, vehicleId: V_REFUSE, permissions: { vehicles_view: true, drivers_manage: false } },
];

/**
 * Prisma minimal pour le résolveur : rejoue le filtre de `resolveForVehicle` (ALL, ou VEHICLE
 * sur ce véhicule) et rend toutes les lignes pour `resolveGlobal` (requête sans `OR`).
 */
function prismaWithAccess(rows: AccessRow[]) {
  const findMany = jest.fn(async ({ where }: { where: { OR?: Array<{ accessType: AccessType; vehicleId?: string }> } }) => {
    if (!where.OR) return rows.map((r) => ({ permissions: r.permissions }));
    const vehicleId = where.OR.find((c) => c.accessType === AccessType.VEHICLE)?.vehicleId;
    return rows
      .filter((r) => r.accessType === AccessType.ALL || (r.accessType === AccessType.VEHICLE && r.vehicleId === vehicleId))
      .map((r) => ({ accessType: r.accessType, permissions: r.permissions }));
  });
  return {
    userVehicleAccess: { findMany },
    tracker: { findUnique: jest.fn() },
  };
}

function ctxFor(user: AuthUser, vehicleId: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, params: { id: vehicleId }, body: { driverId: DRIVER.id }, query: {} }),
    }),
    getHandler: () => VehiclesController.prototype.assignDriver,
    getClass: () => VehiclesController,
  } as unknown as ExecutionContext;
}

function guardWith(rows: AccessRow[]) {
  const prisma = prismaWithAccess(rows);
  const resolver = new PermissionsResolverService(prisma as unknown as PrismaService);
  const guard = new PermissionsGuard(new Reflector(), resolver, prisma as unknown as PrismaService);
  return { guard, prisma };
}

describe('PATCH /vehicles/:id/driver — borné au véhicule visé (revue du 29/09)', () => {
  describe('A. Décorateurs posés sur la route', () => {
    const handler = VehiclesController.prototype.assignDriver;

    it('exige drivers_manage résolu sur CE véhicule (paramètre :id)', () => {
      expect(Reflect.getMetadata(VEHICLE_PERMISSIONS_KEY, handler)).toEqual({
        keys: ['drivers_manage'],
        paramName: 'id',
      });
    });

    it('garde le contrôle global et les mêmes rôles', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['drivers_manage']);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
        UserRole.SUPER_ADMIN,
        UserRole.FLEET_ADMIN,
        UserRole.FLEET_MANAGER,
      ]);
    });
  });

  describe('B. Garde réelle + résolveur réel', () => {
    it('FLEET_MANAGER : passe sur le véhicule où sa ligne accorde drivers_manage', async () => {
      const { guard } = guardWith(MANAGER_ROWS);
      await expect(guard.canActivate(ctxFor(makeUser(UserRole.FLEET_MANAGER), V_OK))).resolves.toBe(true);
    });

    it('FLEET_MANAGER : 403 sur un véhicule dont la ligne refuse drivers_manage', async () => {
      // L'union des scopes donne drivers_manage = true : seul le contrôle par véhicule refuse.
      const { guard } = guardWith(MANAGER_ROWS);
      await expect(guard.canActivate(ctxFor(makeUser(UserRole.FLEET_MANAGER), V_REFUSE))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('FLEET_MANAGER : 403 sur un véhicule de sa société hors de son périmètre', async () => {
      const { guard } = guardWith(MANAGER_ROWS);
      await expect(guard.canActivate(ctxFor(makeUser(UserRole.FLEET_MANAGER), V_HORS))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it.each([UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN])('%s : inchangé, passe sans lire les lignes d’accès', async (role) => {
      const { guard, prisma } = guardWith([]);
      await expect(guard.canActivate(ctxFor(makeUser(role), V_HORS))).resolves.toBe(true);
      expect(prisma.userVehicleAccess.findMany).not.toHaveBeenCalled();
    });
  });

  describe('C. Le contrôleur transmet le périmètre au service', () => {
    function makeController(accessible: string[] | 'ALL') {
      const drivers = { assignToVehicle: jest.fn().mockResolvedValue({ id: V_OK }) };
      const vehicleAccess = { getAccessibleVehicleIds: jest.fn().mockResolvedValue(accessible) };
      const controller = new VehiclesController(
        {} as VehiclesService,
        vehicleAccess as unknown as VehicleAccessService,
        drivers as unknown as DriversService,
        {} as SystemActivityService,
      );
      return { controller, drivers };
    }

    it('passe accessibleVehicleIds (FLEET_MANAGER)', async () => {
      const { controller, drivers } = makeController([V_OK]);
      const user = makeUser(UserRole.FLEET_MANAGER);
      await controller.assignDriver(V_OK, { driverId: DRIVER.id }, { user } as unknown as AuthenticatedRequest);
      expect(drivers.assignToVehicle).toHaveBeenCalledWith(V_OK, DRIVER.id, {
        userId: user.id,
        role: UserRole.FLEET_MANAGER,
        fleetId: FLEET,
        accessibleVehicleIds: [V_OK],
      });
    });
  });

  describe('D. DriversService.assignToVehicle applique le périmètre', () => {
    function makeService() {
      const prisma = {
        vehicle: {
          findFirst: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, fleetId: FLEET })),
          update: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, currentDriver: DRIVER })),
        },
        driver: { findFirst: jest.fn().mockResolvedValue(DRIVER) },
      };
      const service = new DriversService(
        prisma as unknown as PrismaService,
        { record: jest.fn() } as unknown as SystemActivityService,
        { record: jest.fn() } as unknown as ErrorLogger,
      );
      return { service, prisma };
    }

    const manager = { userId: 'm1', role: UserRole.FLEET_MANAGER, fleetId: FLEET, accessibleVehicleIds: [V_OK] };

    it('FLEET_MANAGER hors périmètre : 404, rien n’est lu ni écrit', async () => {
      const { service, prisma } = makeService();
      await expect(service.assignToVehicle(V_HORS, DRIVER.id, manager)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.vehicle.findFirst).not.toHaveBeenCalled();
      expect(prisma.vehicle.update).not.toHaveBeenCalled();
    });

    it('FLEET_MANAGER dans son périmètre : le conducteur est assigné', async () => {
      const { service, prisma } = makeService();
      await service.assignToVehicle(V_OK, DRIVER.id, manager);
      expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({ where: { id: V_OK, fleetId: FLEET } });
      expect(prisma.vehicle.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: V_OK }, data: { currentDriverId: DRIVER.id } }),
      );
    });

    it('FLEET_ADMIN (ALL) : inchangé, borné à sa société seule', async () => {
      const { service, prisma } = makeService();
      await service.assignToVehicle(V_HORS, DRIVER.id, {
        userId: 'a1', role: UserRole.FLEET_ADMIN, fleetId: FLEET, accessibleVehicleIds: 'ALL',
      });
      expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({ where: { id: V_HORS, fleetId: FLEET } });
      expect(prisma.vehicle.update).toHaveBeenCalled();
    });

    it('SUPER_ADMIN (ALL) : inchangé, aucun filtre de société', async () => {
      const { service, prisma } = makeService();
      await service.assignToVehicle(V_HORS, null, {
        userId: 's1', role: UserRole.SUPER_ADMIN, fleetId: null, accessibleVehicleIds: 'ALL',
      });
      expect(prisma.vehicle.findFirst).toHaveBeenCalledWith({ where: { id: V_HORS } });
      expect(prisma.vehicle.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: V_HORS }, data: { currentDriverId: null } }),
      );
    });
  });
});
