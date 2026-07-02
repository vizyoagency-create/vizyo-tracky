import { UnauthorizedException } from '@nestjs/common';
import { InternalSecretGuard } from './internal-secret.guard';
import { InternalController } from './internal.controller';
import { UserRole } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ExecutionContext } from '@nestjs/common';
import type { Env } from '../config/env.validation';

const SECRET = 'test-internal-secret-123';

function createGuard() {
  const config = {
    get: jest.fn().mockReturnValue(SECRET),
  } as unknown as import('@nestjs/config').ConfigService<Env, true>;

  return new InternalSecretGuard(config);
}

function createController() {
  const prisma = {
    fleet: {
      create: jest.fn().mockResolvedValue({
        id: 'fleet-001',
        name: 'Test Fleet',
        clientId: null,
      }),
    },
    user: {
      create: jest.fn().mockResolvedValue({
        id: 'user-001',
        authUserId: 'auth-001',
        email: 'admin@fleet.com',
        role: UserRole.FLEET_ADMIN,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  } as unknown as PrismaService;

  const authClient = {
    register: jest.fn(),
    login: jest.fn(),
    removeUserFromApp: jest.fn(),
  } as unknown as import('../auth-client/auth-client.service').AuthClientService;

  const systemActivity = { record: jest.fn() } as unknown as import('../system-activity/system-activity.service').SystemActivityService;

  return { controller: new InternalController(prisma, authClient, systemActivity), prisma };
}

describe('InternalSecretGuard', () => {
  it('should allow valid secret', () => {
    const guard = createGuard();
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-internal-secret': SECRET },
        }),
      }),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should reject invalid secret', () => {
    const guard = createGuard();
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-internal-secret': 'wrong' },
        }),
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('should reject missing secret', () => {
    const guard = createGuard();
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
        }),
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});

describe('InternalController', () => {
  describe('provisionFleet', () => {
    it('should create fleet and admin user', async () => {
      const { controller, prisma } = createController();
      const result = await controller.provisionFleet({
        fleetName: 'Test Fleet',
        adminAuthUserId: 'auth-001',
        adminEmail: 'admin@fleet.com',
        adminFirstName: 'John',
        adminLastName: 'Doe',
      });

      expect(result).toEqual({ fleetId: 'fleet-001' });
      expect(prisma.fleet.create).toHaveBeenCalledWith({
        data: { name: 'Test Fleet', clientId: undefined },
      });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          authUserId: 'auth-001',
          email: 'admin@fleet.com',
          firstName: 'John',
          lastName: 'Doe',
          role: UserRole.FLEET_ADMIN,
          fleetId: 'fleet-001',
        },
      });
    });
  });

  describe('suspendFleet', () => {
    it('should suspend all users in fleet', async () => {
      const { controller, prisma } = createController();
      const result = await controller.suspendFleet({ fleetId: 'fleet-001' });

      expect(result).toEqual({ status: 'suspended' });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { fleetId: 'fleet-001' },
        data: { isActive: false },
      });
    });
  });

  describe('activateFleet', () => {
    it('should activate all users in fleet', async () => {
      const { controller, prisma } = createController();
      const result = await controller.activateFleet({ fleetId: 'fleet-001' });

      expect(result).toEqual({ status: 'active' });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { fleetId: 'fleet-001' },
        data: { isActive: true },
      });
    });
  });
});
