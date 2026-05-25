import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import type { UserPermissions } from '@vizyo/tracky-shared';
import type { PermissionsResolverService } from '../../permissions/permissions-resolver.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../types/auth-user';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import {
  VEHICLE_PERMISSIONS_KEY,
  type VehiclePermissionsSpec,
} from '../decorators/vehicle-permissions.decorator';
import { PermissionsGuard } from './permissions.guard';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const FLEET_ID = '00000000-0000-0000-0000-000000000010';
const VEHICLE_ID = '00000000-0000-0000-0000-0000000000a1';
const TRACKER_ID = '00000000-0000-0000-0000-0000000000c1';

function makeUser(role: UserRole): AuthUser {
  return {
    id: USER_ID,
    authUserId: 'auth-' + USER_ID,
    email: 'u@test.fr',
    firstName: null,
    lastName: null,
    role,
    fleetId: FLEET_ID,
    isActive: true,
    permissions: null,
  };
}

interface CtxOpts {
  user: AuthUser;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  globalKeys?: Array<keyof UserPermissions>;
  vehicleSpec?: VehiclePermissionsSpec;
}

function makeCtx(opts: CtxOpts) {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === PERMISSIONS_KEY) return opts.globalKeys;
      if (key === VEHICLE_PERMISSIONS_KEY) return opts.vehicleSpec;
      return undefined;
    }),
  } as unknown as Reflector;

  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        user: opts.user,
        params: opts.params ?? {},
        body: opts.body ?? {},
        query: opts.query ?? {},
      }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

  return { reflector, context };
}

function makeResolver(overrides: Partial<PermissionsResolverService> = {}) {
  const stub: Partial<PermissionsResolverService> = {
    canOnVehicle: jest.fn().mockResolvedValue(true),
    canGlobally: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
  return stub as PermissionsResolverService;
}

function makePrisma(trackerLookup?: { vehicle: { id: string } } | null) {
  return {
    tracker: {
      findUnique: jest.fn().mockResolvedValue(trackerLookup ?? null),
    },
  } as unknown as PrismaService;
}

describe('PermissionsGuard', () => {
  describe('aucun decorateur', () => {
    it('return true si aucun @Require* sur la route', async () => {
      const { reflector, context } = makeCtx({ user: makeUser(UserRole.VIEWER) });
      const guard = new PermissionsGuard(reflector, makeResolver(), makePrisma());

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('admin bypass', () => {
    it('SUPER_ADMIN bypass meme avec perm denied configuree', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.SUPER_ADMIN),
        globalKeys: ['vehicles_create'],
      });
      const resolver = makeResolver({ canGlobally: jest.fn().mockResolvedValue(false) });
      const guard = new PermissionsGuard(reflector, resolver, makePrisma());

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(resolver.canGlobally).not.toHaveBeenCalled();
    });

    it('FLEET_ADMIN bypass', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.FLEET_ADMIN),
        globalKeys: ['vehicles_delete'],
      });
      const guard = new PermissionsGuard(reflector, makeResolver(), makePrisma());

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('@RequirePermissions (global)', () => {
    it('autorise quand le resolver renvoie true', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.FLEET_MANAGER),
        globalKeys: ['vehicles_create'],
      });
      const guard = new PermissionsGuard(reflector, makeResolver(), makePrisma());

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('refuse quand le resolver renvoie false', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.VIEWER),
        globalKeys: ['vehicles_create'],
      });
      const resolver = makeResolver({ canGlobally: jest.fn().mockResolvedValue(false) });
      const guard = new PermissionsGuard(reflector, resolver, makePrisma());

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('@RequireVehiclePermission (per-vehicle)', () => {
    it('autorise quand resolver.canOnVehicle = true (paramName par defaut)', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.FLEET_MANAGER),
        params: { vehicleId: VEHICLE_ID },
        vehicleSpec: { keys: ['engine_control'], paramName: 'vehicleId' },
      });
      const resolver = makeResolver({ canOnVehicle: jest.fn().mockResolvedValue(true) });
      const guard = new PermissionsGuard(reflector, resolver, makePrisma());

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(resolver.canOnVehicle).toHaveBeenCalledWith(
        expect.any(Object),
        VEHICLE_ID,
        'engine_control',
      );
    });

    it('refuse quand resolver.canOnVehicle = false', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.VIEWER),
        params: { vehicleId: VEHICLE_ID },
        vehicleSpec: { keys: ['engine_control'], paramName: 'vehicleId' },
      });
      const resolver = makeResolver({ canOnVehicle: jest.fn().mockResolvedValue(false) });
      const guard = new PermissionsGuard(reflector, resolver, makePrisma());

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('extraction depuis body si params vide', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.FLEET_MANAGER),
        body: { vehicleId: VEHICLE_ID },
        vehicleSpec: { keys: ['engine_control'], paramName: 'vehicleId' },
      });
      const resolver = makeResolver();
      const guard = new PermissionsGuard(reflector, resolver, makePrisma());

      await guard.canActivate(context);

      expect(resolver.canOnVehicle).toHaveBeenCalledWith(
        expect.any(Object),
        VEHICLE_ID,
        'engine_control',
      );
    });

    it('extraction depuis query si params + body vides', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.FLEET_MANAGER),
        query: { vehicleId: VEHICLE_ID },
        vehicleSpec: { keys: ['engine_control'], paramName: 'vehicleId' },
      });
      const resolver = makeResolver();
      const guard = new PermissionsGuard(reflector, resolver, makePrisma());

      await guard.canActivate(context);

      expect(resolver.canOnVehicle).toHaveBeenCalledWith(
        expect.any(Object),
        VEHICLE_ID,
        'engine_control',
      );
    });

    it('paramName trackerId → resout via prisma.tracker.findUnique', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.FLEET_MANAGER),
        params: { trackerId: TRACKER_ID },
        vehicleSpec: { keys: ['engine_control'], paramName: 'trackerId' },
      });
      const prisma = makePrisma({ vehicle: { id: VEHICLE_ID } });
      const resolver = makeResolver();
      const guard = new PermissionsGuard(reflector, resolver, prisma);

      await guard.canActivate(context);

      expect(resolver.canOnVehicle).toHaveBeenCalledWith(
        expect.any(Object),
        VEHICLE_ID,
        'engine_control',
      );
    });

    it('paramName trackerId mais tracker introuvable → Forbidden', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.FLEET_MANAGER),
        params: { trackerId: TRACKER_ID },
        vehicleSpec: { keys: ['engine_control'], paramName: 'trackerId' },
      });
      const prisma = makePrisma(null);
      const guard = new PermissionsGuard(reflector, makeResolver(), prisma);

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('vehicleId absent partout → BadRequest', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.VIEWER),
        vehicleSpec: { keys: ['engine_control'], paramName: 'vehicleId' },
      });
      const guard = new PermissionsGuard(reflector, makeResolver(), makePrisma());

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('combinaison @RequirePermissions + @RequireVehiclePermission', () => {
    it('verifie les 2 et autorise si les 2 passent', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.FLEET_MANAGER),
        params: { vehicleId: VEHICLE_ID },
        globalKeys: ['vehicles_view'],
        vehicleSpec: { keys: ['engine_control'], paramName: 'vehicleId' },
      });
      const guard = new PermissionsGuard(reflector, makeResolver(), makePrisma());

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('refuse si la perm per-vehicle echoue meme si la globale passe', async () => {
      const { reflector, context } = makeCtx({
        user: makeUser(UserRole.VIEWER),
        params: { vehicleId: VEHICLE_ID },
        globalKeys: ['vehicles_view'],
        vehicleSpec: { keys: ['engine_control'], paramName: 'vehicleId' },
      });
      const resolver = makeResolver({
        canOnVehicle: jest.fn().mockResolvedValue(false),
        canGlobally: jest.fn().mockResolvedValue(true),
      });
      const guard = new PermissionsGuard(reflector, resolver, makePrisma());

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
