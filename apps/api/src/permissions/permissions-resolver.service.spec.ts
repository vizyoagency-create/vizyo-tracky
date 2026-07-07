import { AccessType, UserRole } from '@prisma/client';
import { getDefaultPermissions, type UserPermissions } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import type { PrismaService } from '../prisma/prisma.service';
import { PermissionsResolverService } from './permissions-resolver.service';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const FLEET_ID = '00000000-0000-0000-0000-000000000010';
const VEHICLE_A = '00000000-0000-0000-0000-0000000000a1';
const VEHICLE_B = '00000000-0000-0000-0000-0000000000a2';
const GROUP_NIGHT = '00000000-0000-0000-0000-0000000000b1';

function makeUser(role: UserRole, permissions: Partial<UserPermissions> | null = null): AuthUser {
  return {
    id: USER_ID,
    authUserId: 'auth-' + USER_ID,
    email: 'u@test.fr',
    firstName: null,
    lastName: null,
    role,
    fleetId: FLEET_ID,
    isActive: true,
    isOwner: false,
    permissions: permissions
      ? ({ ...getDefaultPermissions(role as never), ...permissions } as UserPermissions)
      : null,
  };
}

function makePrismaMock(findManyImpl: jest.Mock) {
  return {
    userVehicleAccess: { findMany: findManyImpl },
  } as unknown as PrismaService;
}

describe('PermissionsResolverService', () => {
  describe('resolveForVehicle', () => {
    it('retourne tous true pour SUPER_ADMIN sans query', async () => {
      const findMany = jest.fn();
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.SUPER_ADMIN);

      const perms = await svc.resolveForVehicle(user, VEHICLE_A);

      expect(perms).not.toBeNull();
      expect(perms!.engine_control).toBe(true);
      expect(perms!.vehicles_create).toBe(true);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('retourne tous true pour FLEET_ADMIN sans query', async () => {
      const findMany = jest.fn();
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.FLEET_ADMIN);

      const perms = await svc.resolveForVehicle(user, VEHICLE_A);

      expect(perms).not.toBeNull();
      expect(perms!.engine_control).toBe(true);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('retourne null si aucune ligne d\'acces ne couvre ce vehicule', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.VIEWER);

      const perms = await svc.resolveForVehicle(user, VEHICLE_A);

      expect(perms).toBeNull();
    });

    it('applique les permissions de la ligne ALL si c\'est la seule', async () => {
      const findMany = jest.fn().mockResolvedValue([
        {
          accessType: AccessType.ALL,
          permissions: { ...getDefaultPermissions('VIEWER'), engine_control: true },
        },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.VIEWER);

      const perms = await svc.resolveForVehicle(user, VEHICLE_A);

      expect(perms!.engine_control).toBe(true);
      expect(perms!.vehicles_view).toBe(true);
      expect(perms!.vehicles_delete).toBe(false);
    });

    it('regle "specifique gagne" : VEHICLE override GROUP override ALL', async () => {
      // engine_control: ALL=true, GROUP=true, VEHICLE=false → false attendu
      const findMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.ALL, permissions: { engine_control: true } },
        { accessType: AccessType.GROUP, permissions: { engine_control: true } },
        { accessType: AccessType.VEHICLE, permissions: { engine_control: false } },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.FLEET_MANAGER);

      const perms = await svc.resolveForVehicle(user, VEHICLE_A);

      expect(perms!.engine_control).toBe(false);
    });

    it('GROUP gagne sur ALL quand pas de ligne VEHICLE', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.ALL, permissions: { engine_control: true } },
        { accessType: AccessType.GROUP, permissions: { engine_control: false } },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.FLEET_MANAGER);

      const perms = await svc.resolveForVehicle(user, VEHICLE_A);

      expect(perms!.engine_control).toBe(false);
    });

    it('cles manquantes du scope sont comblees par user.permissions', async () => {
      // Scope ne porte que engine_control. Le reste vient de user.permissions
      // (qui est null → fallback defaults FLEET_MANAGER).
      const findMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.ALL, permissions: { engine_control: true } },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.FLEET_MANAGER);

      const perms = await svc.resolveForVehicle(user, VEHICLE_A);

      expect(perms!.engine_control).toBe(true);
      // vehicles_create vient des defaults FLEET_MANAGER
      expect(perms!.vehicles_create).toBe(true);
    });

    it('si scope permissions est null, fallback total sur user.permissions', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.ALL, permissions: null },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.VIEWER, { engine_control: true, vehicles_view: true });

      const perms = await svc.resolveForVehicle(user, VEHICLE_A);

      expect(perms!.engine_control).toBe(true);
      expect(perms!.vehicles_view).toBe(true);
    });

    it('memoization : 2 appels avec meme vehicleId → 1 query', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.ALL, permissions: { vehicles_view: true } },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.VIEWER);

      await svc.resolveForVehicle(user, VEHICLE_A);
      await svc.resolveForVehicle(user, VEHICLE_A);

      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('memoization : appels sur vehicleIds differents = 2 queries', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.VIEWER);

      await svc.resolveForVehicle(user, VEHICLE_A);
      await svc.resolveForVehicle(user, VEHICLE_B);

      expect(findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('resolveGlobal', () => {
    it('retourne defaults admins pour SUPER_ADMIN', async () => {
      const findMany = jest.fn();
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.SUPER_ADMIN);

      const perms = await svc.resolveGlobal(user);

      expect(perms.engine_control).toBe(true);
      expect(perms.users_manage).toBe(true);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('union : true si au moins un scope autorise', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { permissions: { vehicles_create: false, engine_control: false } },
        { permissions: { vehicles_create: true, engine_control: false } },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.FLEET_MANAGER);

      const perms = await svc.resolveGlobal(user);

      expect(perms.vehicles_create).toBe(true);
      expect(perms.engine_control).toBe(false);
    });

    it('aucune ligne d\'acces → fallback user.permissions', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.VIEWER, { engine_control: true });

      const perms = await svc.resolveGlobal(user);

      expect(perms.engine_control).toBe(true);
    });
  });

  describe('canOnVehicle / canGlobally', () => {
    it('canOnVehicle: true si la perm est autorisee sur ce vehicule', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.ALL, permissions: { engine_control: true } },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.FLEET_MANAGER);

      const ok = await svc.canOnVehicle(user, VEHICLE_A, 'engine_control');
      expect(ok).toBe(true);
    });

    it('canOnVehicle: false si aucune ligne ne couvre le vehicule', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.FLEET_MANAGER);

      const ok = await svc.canOnVehicle(user, VEHICLE_A, 'engine_control');
      expect(ok).toBe(false);
    });

    it('canOnVehicle: admin bypass', async () => {
      const findMany = jest.fn();
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.FLEET_ADMIN);

      const ok = await svc.canOnVehicle(user, VEHICLE_A, 'engine_control');
      expect(ok).toBe(true);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('canGlobally: union → true si un scope autorise', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { permissions: { groups_manage: true } },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.FLEET_MANAGER);

      expect(await svc.canGlobally(user, 'groups_manage')).toBe(true);
    });
  });

  describe('resolveForVehicles (batch)', () => {
    it('admin : Map peuplee avec tous true', async () => {
      const findMany = jest.fn();
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.SUPER_ADMIN);

      const result = await svc.resolveForVehicles(user, [VEHICLE_A, VEHICLE_B]);

      expect(result.size).toBe(2);
      expect(result.get(VEHICLE_A)?.engine_control).toBe(true);
      expect(result.get(VEHICLE_B)?.engine_control).toBe(true);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('liste vide → Map vide sans query', async () => {
      const findMany = jest.fn();
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.VIEWER);

      const result = await svc.resolveForVehicles(user, []);

      expect(result.size).toBe(0);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('1 seule query pour N vehicules + applique regle specificite', async () => {
      // VEHICLE_A : ALL grant engine, GROUP_NIGHT revoke
      // VEHICLE_B : juste ALL grant engine
      const findMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.ALL, permissions: { engine_control: true }, vehicleId: null, group: null },
        {
          accessType: AccessType.GROUP,
          permissions: { engine_control: false },
          vehicleId: null,
          group: { vehicles: [{ vehicleId: VEHICLE_A }] },
        },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.FLEET_MANAGER);

      const result = await svc.resolveForVehicles(user, [VEHICLE_A, VEHICLE_B]);

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(result.get(VEHICLE_A)?.engine_control).toBe(false); // GROUP override
      expect(result.get(VEHICLE_B)?.engine_control).toBe(true);  // ALL only
    });

    it('hydrate le cache pour les appels resolveForVehicle ulterieurs', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.ALL, permissions: { vehicles_view: true }, vehicleId: null, group: null },
      ]);
      const svc = new PermissionsResolverService(makePrismaMock(findMany));
      const user = makeUser(UserRole.VIEWER);

      await svc.resolveForVehicles(user, [VEHICLE_A]);
      // Le 2e appel ne doit PAS re-query (cache hit)
      await svc.resolveForVehicle(user, VEHICLE_A);

      expect(findMany).toHaveBeenCalledTimes(1);
    });
  });
});
