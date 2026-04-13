import { UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AuthService, VizyoAccessPayload } from './auth.service';
import type { AuthClientService } from '../auth-client/auth-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import type { Env } from '../config/env.validation';

const JWT_SECRET = 'test-secret-key-for-jwt-signing';
const JWT_ISSUER = 'vizyo-auth';
const APP_INTERNAL_ID = 'test-app-id';
const AUTH_USER_ID = 'auth-user-123';
const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001';
const FLEET_ID = '00000000-0000-0000-0000-000000000002';

function makeToken(overrides: Partial<VizyoAccessPayload> = {}): string {
  const payload: VizyoAccessPayload = {
    iss: JWT_ISSUER,
    aud: 'api',
    sub: AUTH_USER_ID,
    appId: APP_INTERNAL_ID,
    typ: 'access',
    jti: 'test-jti',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  return jwt.sign(payload, JWT_SECRET);
}

const localUser = {
  id: LOCAL_USER_ID,
  authUserId: AUTH_USER_ID,
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  role: UserRole.FLEET_ADMIN,
  fleetId: FLEET_ID,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createService(
  prismaOverride?: Partial<PrismaService>,
  authClientOverride?: Partial<AuthClientService>,
) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(localUser),
    },
    ...prismaOverride,
  } as unknown as PrismaService;

  const config = {
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        VIZYO_AUTH_JWT_ACCESS_SECRET: JWT_SECRET,
        VIZYO_AUTH_JWT_ISSUER: JWT_ISSUER,
        VIZYO_AUTH_APP_INTERNAL_ID: APP_INTERNAL_ID,
      };
      return map[key];
    }),
  } as unknown as import('@nestjs/config').ConfigService<Env, true>;

  const authClient = {
    login: jest.fn().mockResolvedValue({
      accessToken: makeToken(),
      refreshToken: 'refresh-token-123',
    }),
    ...authClientOverride,
  } as unknown as AuthClientService;

  return new AuthService(prisma, config, authClient);
}

describe('AuthService', () => {
  describe('login', () => {
    it('should return accessToken, refreshToken and user on success', async () => {
      const service = createService();
      const result = await service.login('test@example.com', 'password123');

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBe('refresh-token-123');
      expect(result.user).toEqual({
        id: LOCAL_USER_ID,
        email: 'test@example.com',
        role: UserRole.FLEET_ADMIN,
        fleetId: FLEET_ID,
      });
    });

    it('should throw 401 when Auth rejects credentials', async () => {
      const service = createService(undefined, {
        login: jest.fn().mockRejectedValue(new UnauthorizedException()),
      });

      await expect(service.login('bad@example.com', 'wrong')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw 401 when local user not found', async () => {
      const service = createService({
        user: { findUnique: jest.fn().mockResolvedValue(null) },
      } as unknown as Partial<PrismaService>);

      await expect(service.login('test@example.com', 'password123')).rejects.toThrow(
        'User not provisioned in Tracky',
      );
    });

    it('should throw 401 when local user is suspended', async () => {
      const service = createService({
        user: {
          findUnique: jest.fn().mockResolvedValue({ ...localUser, isActive: false }),
        },
      } as unknown as Partial<PrismaService>);

      await expect(service.login('test@example.com', 'password123')).rejects.toThrow(
        'Account suspended',
      );
    });
  });

  describe('verifyAccessToken', () => {
    it('should verify a valid token', () => {
      const service = createService();
      const token = makeToken();
      const payload = service.verifyAccessToken(token);

      expect(payload.sub).toBe(AUTH_USER_ID);
      expect(payload.aud).toBe('api');
      expect(payload.typ).toBe('access');
    });

    it('should reject token with wrong issuer', () => {
      const service = createService();
      const token = makeToken({ iss: 'wrong-issuer' });

      expect(() => service.verifyAccessToken(token)).toThrow('Invalid token issuer');
    });

    it('should reject token with wrong audience', () => {
      const service = createService();
      const token = makeToken({ aud: 'wrong' });

      expect(() => service.verifyAccessToken(token)).toThrow('Invalid token audience');
    });

    it('should reject token with wrong type', () => {
      const service = createService();
      const token = makeToken({ typ: 'refresh' });

      expect(() => service.verifyAccessToken(token)).toThrow('Invalid token type');
    });

    it('should reject token with wrong appId', () => {
      const service = createService();
      const token = makeToken({ appId: 'wrong-app' });

      expect(() => service.verifyAccessToken(token)).toThrow('Invalid token app');
    });

    it('should reject expired token', () => {
      const service = createService();
      const token = makeToken({ exp: Math.floor(Date.now() / 1000) - 60 });

      expect(() => service.verifyAccessToken(token)).toThrow('Invalid or expired token');
    });
  });

  describe('resolveLocalUser', () => {
    it('should resolve local user by authUserId', async () => {
      const service = createService();
      const user = await service.resolveLocalUser(AUTH_USER_ID);

      expect(user.id).toBe(LOCAL_USER_ID);
      expect(user.authUserId).toBe(AUTH_USER_ID);
      expect(user.role).toBe(UserRole.FLEET_ADMIN);
    });

    it('should throw when user not found', async () => {
      const service = createService({
        user: { findUnique: jest.fn().mockResolvedValue(null) },
      } as unknown as Partial<PrismaService>);

      await expect(service.resolveLocalUser('unknown')).rejects.toThrow(
        'User not provisioned in Tracky',
      );
    });

    it('should throw when user is suspended', async () => {
      const service = createService({
        user: {
          findUnique: jest.fn().mockResolvedValue({ ...localUser, isActive: false }),
        },
      } as unknown as Partial<PrismaService>);

      await expect(service.resolveLocalUser(AUTH_USER_ID)).rejects.toThrow(
        'Account suspended',
      );
    });
  });
});
