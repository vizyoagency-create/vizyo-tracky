import { AccessType, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import type { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from './vehicle-access.service';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const FLEET_ID = '00000000-0000-0000-0000-000000000010';
const VEHICLE_A = '00000000-0000-0000-0000-0000000000a1';
const VEHICLE_B = '00000000-0000-0000-0000-0000000000a2';
const VEHICLE_C = '00000000-0000-0000-0000-0000000000a3';
const GROUP_NIGHT = '00000000-0000-0000-0000-0000000000b1';

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
    isOwner: false,
    permissions: null,
  };
}

interface PrismaMockFns {
  accessFindMany?: jest.Mock;
  assignmentsFindMany?: jest.Mock;
}

function makePrismaMock(fns: PrismaMockFns & { vehicleFindUnique?: jest.Mock } = {}) {
  return {
    userVehicleAccess: { findMany: fns.accessFindMany ?? jest.fn().mockResolvedValue([]) },
    vehicleGroupAssignment: {
      findMany: fns.assignmentsFindMany ?? jest.fn().mockResolvedValue([]),
    },
    // Appartenance du vehicule a une flotte. Par defaut : MEME flotte que l'utilisateur
    // de test — les cas inter-flotte la surchargent explicitement.
    vehicle: { findUnique: fns.vehicleFindUnique ?? jest.fn().mockResolvedValue({ fleetId: FLEET_ID }) },
  } as unknown as PrismaService;
}

describe('VehicleAccessService', () => {
  describe('getAccessibleVehicleIds', () => {
    it('SUPER_ADMIN → "ALL" sans query', async () => {
      const accessFindMany = jest.fn();
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany }));

      const result = await svc.getAccessibleVehicleIds(makeUser(UserRole.SUPER_ADMIN));

      expect(result).toBe('ALL');
      expect(accessFindMany).not.toHaveBeenCalled();
    });

    it('FLEET_ADMIN → "ALL" sans query', async () => {
      const accessFindMany = jest.fn();
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany }));

      const result = await svc.getAccessibleVehicleIds(makeUser(UserRole.FLEET_ADMIN));

      expect(result).toBe('ALL');
      expect(accessFindMany).not.toHaveBeenCalled();
    });

    it('FLEET_MANAGER sans aucune regle → []', async () => {
      const accessFindMany = jest.fn().mockResolvedValue([]);
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany }));

      const result = await svc.getAccessibleVehicleIds(makeUser(UserRole.FLEET_MANAGER));

      expect(result).toEqual([]);
    });

    it('regle ALL → "ALL"', async () => {
      const accessFindMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.ALL, groupId: null, vehicleId: null },
      ]);
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany }));

      const result = await svc.getAccessibleVehicleIds(makeUser(UserRole.VIEWER));

      expect(result).toBe('ALL');
    });

    it('regles VEHICLE → liste des ids', async () => {
      const accessFindMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.VEHICLE, groupId: null, vehicleId: VEHICLE_A },
        { accessType: AccessType.VEHICLE, groupId: null, vehicleId: VEHICLE_B },
      ]);
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany }));

      const result = await svc.getAccessibleVehicleIds(makeUser(UserRole.VIEWER));

      expect(result).toEqual(expect.arrayContaining([VEHICLE_A, VEHICLE_B]));
      expect(result).toHaveLength(2);
    });

    it('regle GROUP → resout les vehicleIds via assignments', async () => {
      const accessFindMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.GROUP, groupId: GROUP_NIGHT, vehicleId: null },
      ]);
      const assignmentsFindMany = jest.fn().mockResolvedValue([
        { vehicleId: VEHICLE_A },
        { vehicleId: VEHICLE_C },
      ]);
      const svc = new VehicleAccessService(
        makePrismaMock({ accessFindMany, assignmentsFindMany }),
      );

      const result = await svc.getAccessibleVehicleIds(makeUser(UserRole.VIEWER));

      expect(result).toEqual(expect.arrayContaining([VEHICLE_A, VEHICLE_C]));
      expect(result).toHaveLength(2);
    });

    it('VEHICLE + GROUP → union dedupliquee', async () => {
      const accessFindMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.VEHICLE, groupId: null, vehicleId: VEHICLE_A },
        { accessType: AccessType.GROUP, groupId: GROUP_NIGHT, vehicleId: null },
      ]);
      // Le groupe contient VEHICLE_A (dedup) + VEHICLE_B
      const assignmentsFindMany = jest.fn().mockResolvedValue([
        { vehicleId: VEHICLE_A },
        { vehicleId: VEHICLE_B },
      ]);
      const svc = new VehicleAccessService(
        makePrismaMock({ accessFindMany, assignmentsFindMany }),
      );

      const result = await svc.getAccessibleVehicleIds(makeUser(UserRole.FLEET_MANAGER));

      expect(result).toEqual(expect.arrayContaining([VEHICLE_A, VEHICLE_B]));
      expect(result).toHaveLength(2);
    });

    it('memoization : 2 appels → 1 query', async () => {
      const accessFindMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.VEHICLE, groupId: null, vehicleId: VEHICLE_A },
      ]);
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany }));
      const user = makeUser(UserRole.VIEWER);

      await svc.getAccessibleVehicleIds(user);
      await svc.getAccessibleVehicleIds(user);

      expect(accessFindMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('hasAccessToVehicle', () => {
    /**
     * ⚠️ CES DEUX TESTS VERROUILLAIENT LA FAILLE.
     *
     * Ils affirmaient « admin → true SANS query » et « acces ALL → true », c'est-a-dire
     * exactement le comportement qui ouvrait un IDOR inter-societes : avec un UUID d'un
     * vehicule d'une autre flotte, un FLEET_ADMIN passait la garde. Et ces UUID etaient
     * livres en clair par la carte des stations-service (fuite corrigee le meme jour).
     *
     * Le sentinel `'ALL'` signifie « aucune restriction PAR VEHICULE », sous-entendu dans
     * SA flotte — jamais « tous les vehicules de la base ». On verifie donc l'appartenance.
     */
    it('⚠️ FLEET_ADMIN : autorise dans SA flotte…', async () => {
      const accessFindMany = jest.fn();
      const vehicleFindUnique = jest.fn().mockResolvedValue({ fleetId: FLEET_ID });
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany, vehicleFindUnique }));

      expect(await svc.hasAccessToVehicle(makeUser(UserRole.FLEET_ADMIN), VEHICLE_A)).toBe(true);
      // Toujours aucune lecture des regles d'acces : le raccourci de perf est conserve.
      expect(accessFindMany).not.toHaveBeenCalled();
    });

    it('⚠️ …et REFUSE sur un vehicule d’une AUTRE flotte (l’IDOR)', async () => {
      const vehicleFindUnique = jest.fn().mockResolvedValue({ fleetId: 'une-autre-flotte' });
      const svc = new VehicleAccessService(makePrismaMock({ vehicleFindUnique }));

      expect(await svc.hasAccessToVehicle(makeUser(UserRole.FLEET_ADMIN), VEHICLE_A)).toBe(false);
    });

    it('un vehicule INEXISTANT est refuse, pas autorise par defaut', async () => {
      const vehicleFindUnique = jest.fn().mockResolvedValue(null);
      const svc = new VehicleAccessService(makePrismaMock({ vehicleFindUnique }));

      expect(await svc.hasAccessToVehicle(makeUser(UserRole.FLEET_ADMIN), VEHICLE_A)).toBe(false);
    });

    it('SUPER_ADMIN : perimetre reellement illimite, sans lecture du vehicule', async () => {
      // Le seul role pour qui `'ALL'` veut dire « toute la base ».
      const vehicleFindUnique = jest.fn();
      const svc = new VehicleAccessService(makePrismaMock({ vehicleFindUnique }));

      expect(await svc.hasAccessToVehicle(makeUser(UserRole.SUPER_ADMIN), VEHICLE_A)).toBe(true);
      expect(vehicleFindUnique).not.toHaveBeenCalled();
    });

    it('user avec une regle ALL : borne a sa flotte, pas a la base', async () => {
      const accessFindMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.ALL, groupId: null, vehicleId: null },
      ]);
      const vehicleFindUnique = jest.fn().mockResolvedValue({ fleetId: 'une-autre-flotte' });
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany, vehicleFindUnique }));

      expect(await svc.hasAccessToVehicle(makeUser(UserRole.VIEWER), VEHICLE_A)).toBe(false);
    });

    it('user avec acces VEHICLE specifique → true seulement pour ces ids', async () => {
      const accessFindMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.VEHICLE, groupId: null, vehicleId: VEHICLE_A },
      ]);
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany }));
      const user = makeUser(UserRole.VIEWER);

      expect(await svc.hasAccessToVehicle(user, VEHICLE_A)).toBe(true);
      // Re-cree un user pour reset le cache request-scoped
      expect(await svc.hasAccessToVehicle(makeUser(UserRole.VIEWER), VEHICLE_B)).toBe(false);
    });

    it('user sans regle → false', async () => {
      const accessFindMany = jest.fn().mockResolvedValue([]);
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany }));

      const ok = await svc.hasAccessToVehicle(makeUser(UserRole.VIEWER), VEHICLE_A);

      expect(ok).toBe(false);
    });
  });

  describe('buildVehicleFilter', () => {
    it('SUPER_ADMIN → filtre vide', async () => {
      const svc = new VehicleAccessService(makePrismaMock());

      const filter = await svc.buildVehicleFilter(makeUser(UserRole.SUPER_ADMIN));

      expect(filter).toEqual({});
    });

    it('FLEET_ADMIN → filtre par fleetId', async () => {
      const svc = new VehicleAccessService(makePrismaMock());

      const filter = await svc.buildVehicleFilter(makeUser(UserRole.FLEET_ADMIN));

      expect(filter).toEqual({ fleetId: FLEET_ID });
    });

    it('VIEWER avec acces VEHICLE → filtre par id IN', async () => {
      const accessFindMany = jest.fn().mockResolvedValue([
        { accessType: AccessType.VEHICLE, groupId: null, vehicleId: VEHICLE_A },
      ]);
      const svc = new VehicleAccessService(makePrismaMock({ accessFindMany }));

      const filter = await svc.buildVehicleFilter(makeUser(UserRole.VIEWER));

      expect(filter).toEqual({ id: { in: [VEHICLE_A] } });
    });

    it('FLEET_ADMIN sans fleetId → match-nothing (audit residual, fail-closed)', async () => {
      const svc = new VehicleAccessService(makePrismaMock());
      const user = { ...makeUser(UserRole.FLEET_ADMIN), fleetId: null };

      const filter = await svc.buildVehicleFilter(user);

      // Avant le fix : { fleetId: undefined } → Prisma droppe le filtre → toutes flottes.
      expect(filter).toEqual({ id: { in: [] } });
    });
  });
});
