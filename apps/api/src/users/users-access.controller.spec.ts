import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AccessType, UserRole } from '@prisma/client';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import type { AuthUser } from '../auth/types/auth-user';
import type { PrismaService } from '../prisma/prisma.service';
import type { AccessEntryDto, SetUserAccessDto } from './dto/set-access.dto';
import { UsersController } from './users.controller';

/**
 * Tests cibles sur les nouveaux endpoints d'acces matrice (PR 2 — V1.11 Phase 1).
 * Hors scope : tests d'invitation et de creation user (deja couverts ailleurs).
 */

const USER_ID = '00000000-0000-0000-0000-000000000001';
const FLEET_ID = '00000000-0000-0000-0000-000000000010';
const OTHER_FLEET_ID = '00000000-0000-0000-0000-000000000020';
const ACCESS_ID = '00000000-0000-0000-0000-0000000000a1';
const GROUP_ID = '00000000-0000-0000-0000-0000000000b1';
const FOREIGN_GROUP_ID = '00000000-0000-0000-0000-0000000000b2';
const VEHICLE_ID = '00000000-0000-0000-0000-0000000000c1';
const ADMIN_ID = '00000000-0000-0000-0000-000000000099';

function makeReq(role: UserRole, fleetId: string | null = FLEET_ID): AuthenticatedRequest {
  const user: AuthUser = {
    id: ADMIN_ID,
    authUserId: 'auth-' + ADMIN_ID,
    email: 'a@test.fr',
    firstName: null,
    lastName: null,
    role,
    fleetId,
    isActive: true,
    isOwner: false,
    permissions: null,
  };
  return { user } as AuthenticatedRequest;
}

interface PrismaMockSetup {
  userFindFirst?: jest.Mock;
  accessFindFirst?: jest.Mock;
  accessUpdate?: jest.Mock;
  accessDelete?: jest.Mock;
  accessCount?: jest.Mock;
  accessFindMany?: jest.Mock;
  accessDeleteMany?: jest.Mock;
  accessCreateMany?: jest.Mock;
  groupFindMany?: jest.Mock;
  vehicleFindMany?: jest.Mock;
  txn?: jest.Mock;
}

function makePrisma(setup: PrismaMockSetup = {}): PrismaService {
  const txn =
    setup.txn ??
    jest.fn((ops: unknown[]) => Promise.all(ops.map((op) => (op as Promise<unknown>) ?? null)));
  return {
    user: { findFirst: setup.userFindFirst ?? jest.fn() },
    userVehicleAccess: {
      findFirst: setup.accessFindFirst ?? jest.fn(),
      update: setup.accessUpdate ?? jest.fn(),
      delete: setup.accessDelete ?? jest.fn(),
      count: setup.accessCount ?? jest.fn(),
      findMany: setup.accessFindMany ?? jest.fn().mockResolvedValue([]),
      deleteMany: setup.accessDeleteMany ?? jest.fn().mockResolvedValue({ count: 0 }),
      createMany: setup.accessCreateMany ?? jest.fn().mockResolvedValue({ count: 0 }),
    },
    vehicleGroup: { findMany: setup.groupFindMany ?? jest.fn().mockResolvedValue([]) },
    vehicle: { findMany: setup.vehicleFindMany ?? jest.fn().mockResolvedValue([]) },
    $transaction: txn,
  } as unknown as PrismaService;
}

function makeController(prisma: PrismaService): UsersController {
  // Les autres deps (authClient, invitations, emailService, config) ne sont pas
  // utilisees par les endpoints d'acces — on les passe en {} caste.
  return new UsersController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    // Owner plateforme — isMasked=false ⇒ assertTargetVisible no-op (tests d'accès inchangés).
    { isMasked: () => false } as never,
  );
}

describe('UsersController — endpoints d\'acces matrice (PR 2)', () => {
  describe('PATCH /users/:userId/access/:accessId', () => {
    it('met a jour les permissions d\'une ligne d\'acces', async () => {
      const accessUpdate = jest.fn().mockResolvedValue({
        id: ACCESS_ID,
        accessType: AccessType.ALL,
        groupId: null,
        vehicleId: null,
        permissions: { engine_control: true },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const prisma = makePrisma({
        userFindFirst: jest.fn().mockResolvedValue({ id: USER_ID, fleetId: FLEET_ID }),
        accessFindFirst: jest.fn().mockResolvedValue({ id: ACCESS_ID, userId: USER_ID }),
        accessUpdate,
      });

      const result = await makeController(prisma).updateAccessPermissions(
        USER_ID,
        ACCESS_ID,
        { permissions: { engine_control: true } },
        makeReq(UserRole.FLEET_ADMIN),
      );

      expect(accessUpdate).toHaveBeenCalledWith({
        where: { id: ACCESS_ID },
        data: { permissions: { engine_control: true } },
        select: expect.any(Object),
      });
      expect(result.permissions).toEqual({ engine_control: true });
    });

    it('404 si l\'user cible est dans une autre flotte', async () => {
      const prisma = makePrisma({
        userFindFirst: jest.fn().mockResolvedValue(null),
      });

      await expect(
        makeController(prisma).updateAccessPermissions(
          USER_ID,
          ACCESS_ID,
          { permissions: {} },
          makeReq(UserRole.FLEET_ADMIN, FLEET_ID),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404 si la ligne d\'acces appartient a un autre user', async () => {
      const prisma = makePrisma({
        userFindFirst: jest.fn().mockResolvedValue({ id: USER_ID, fleetId: FLEET_ID }),
        accessFindFirst: jest.fn().mockResolvedValue(null),
      });

      await expect(
        makeController(prisma).updateAccessPermissions(
          USER_ID,
          ACCESS_ID,
          { permissions: {} },
          makeReq(UserRole.FLEET_ADMIN),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('SUPER_ADMIN peut editer tout user (pas de filtre fleet)', async () => {
      const userFindFirst = jest
        .fn()
        .mockResolvedValue({ id: USER_ID, fleetId: OTHER_FLEET_ID });
      const prisma = makePrisma({
        userFindFirst,
        accessFindFirst: jest.fn().mockResolvedValue({ id: ACCESS_ID, userId: USER_ID }),
        accessUpdate: jest.fn().mockResolvedValue({}),
      });

      await makeController(prisma).updateAccessPermissions(
        USER_ID,
        ACCESS_ID,
        { permissions: {} },
        makeReq(UserRole.SUPER_ADMIN, null),
      );

      // findFirst doit etre appele sans contrainte fleetId
      expect(userFindFirst).toHaveBeenCalledWith({ where: { id: USER_ID } });
    });
  });

  describe('DELETE /users/:userId/access/:accessId', () => {
    it('supprime une ligne quand il y en a plus d\'une', async () => {
      const accessDelete = jest.fn().mockResolvedValue({});
      const prisma = makePrisma({
        userFindFirst: jest.fn().mockResolvedValue({ id: USER_ID, fleetId: FLEET_ID }),
        accessFindFirst: jest.fn().mockResolvedValue({ id: ACCESS_ID, userId: USER_ID }),
        accessCount: jest.fn().mockResolvedValue(2),
        accessDelete,
      });

      const result = await makeController(prisma).deleteAccessEntry(
        USER_ID,
        ACCESS_ID,
        makeReq(UserRole.FLEET_ADMIN),
      );

      expect(accessDelete).toHaveBeenCalledWith({ where: { id: ACCESS_ID } });
      expect(result).toEqual({ ok: true });
    });

    it('refuse la suppression de la derniere ligne (sinon user sans acces)', async () => {
      const accessDelete = jest.fn();
      const prisma = makePrisma({
        userFindFirst: jest.fn().mockResolvedValue({ id: USER_ID, fleetId: FLEET_ID }),
        accessFindFirst: jest.fn().mockResolvedValue({ id: ACCESS_ID, userId: USER_ID }),
        accessCount: jest.fn().mockResolvedValue(1),
        accessDelete,
      });

      await expect(
        makeController(prisma).deleteAccessEntry(
          USER_ID,
          ACCESS_ID,
          makeReq(UserRole.FLEET_ADMIN),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(accessDelete).not.toHaveBeenCalled();
    });
  });

  describe('PUT /users/:id/access (format entries[] enrichi)', () => {
    it('cree les lignes avec permissions et valide multi-flotte', async () => {
      const accessDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
      const accessCreateMany = jest.fn().mockResolvedValue({ count: 2 });
      const groupFindMany = jest.fn().mockResolvedValue([{ id: GROUP_ID }]);
      const vehicleFindMany = jest.fn().mockResolvedValue([{ id: VEHICLE_ID }]);
      const accessFindMany = jest.fn().mockResolvedValue([
        { id: 'r1', accessType: AccessType.GROUP, groupId: GROUP_ID, vehicleId: null, permissions: { engine_control: true } },
        { id: 'r2', accessType: AccessType.VEHICLE, groupId: null, vehicleId: VEHICLE_ID, permissions: null },
      ]);

      const prisma = makePrisma({
        userFindFirst: jest.fn().mockResolvedValue({ id: USER_ID, fleetId: FLEET_ID }),
        accessDeleteMany,
        accessCreateMany,
        accessFindMany,
        groupFindMany,
        vehicleFindMany,
      });

      const dto: SetUserAccessDto = {
        entries: [
          { type: 'GROUP', groupId: GROUP_ID, permissions: { engine_control: true } } as AccessEntryDto,
          { type: 'VEHICLE', vehicleId: VEHICLE_ID } as AccessEntryDto,
        ],
      };

      const result = await makeController(prisma).setAccess(
        USER_ID,
        dto,
        makeReq(UserRole.FLEET_ADMIN),
      );

      expect(groupFindMany).toHaveBeenCalledWith({
        where: { id: { in: [GROUP_ID] }, fleetId: FLEET_ID },
        select: { id: true },
      });
      expect(vehicleFindMany).toHaveBeenCalledWith({
        where: { id: { in: [VEHICLE_ID] }, fleetId: FLEET_ID },
        select: { id: true },
      });
      expect(accessCreateMany).toHaveBeenCalled();
      expect(result.entries).toHaveLength(2);
    });

    it('refuse une entree GROUP d\'une autre flotte', async () => {
      const prisma = makePrisma({
        userFindFirst: jest.fn().mockResolvedValue({ id: USER_ID, fleetId: FLEET_ID }),
        // findMany retourne 0 → groupe pas dans la fleet → reject
        groupFindMany: jest.fn().mockResolvedValue([]),
      });

      const dto: SetUserAccessDto = {
        entries: [
          { type: 'GROUP', groupId: FOREIGN_GROUP_ID } as AccessEntryDto,
        ],
      };

      await expect(
        makeController(prisma).setAccess(USER_ID, dto, makeReq(UserRole.FLEET_ADMIN)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuse entries vides', async () => {
      const prisma = makePrisma({
        userFindFirst: jest.fn().mockResolvedValue({ id: USER_ID, fleetId: FLEET_ID }),
      });

      await expect(
        makeController(prisma).setAccess(
          USER_ID,
          { entries: [] },
          makeReq(UserRole.FLEET_ADMIN),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuse entry GROUP sans groupId', async () => {
      const prisma = makePrisma({
        userFindFirst: jest.fn().mockResolvedValue({ id: USER_ID, fleetId: FLEET_ID }),
      });

      await expect(
        makeController(prisma).setAccess(
          USER_ID,
          { entries: [{ type: 'GROUP' } as AccessEntryDto] },
          makeReq(UserRole.FLEET_ADMIN),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('format legacy type=ALL → cree une entry ALL', async () => {
      const accessCreateMany = jest.fn().mockResolvedValue({ count: 1 });
      const accessFindMany = jest.fn().mockResolvedValue([
        { id: 'r1', accessType: AccessType.ALL, groupId: null, vehicleId: null, permissions: null },
      ]);
      const prisma = makePrisma({
        userFindFirst: jest.fn().mockResolvedValue({ id: USER_ID, fleetId: FLEET_ID }),
        accessCreateMany,
        accessFindMany,
      });

      const result = await makeController(prisma).setAccess(
        USER_ID,
        { type: 'ALL' },
        makeReq(UserRole.FLEET_ADMIN),
      );

      expect(accessCreateMany).toHaveBeenCalledWith({
        data: [
          {
            userId: USER_ID,
            accessType: AccessType.ALL,
            groupId: null,
            vehicleId: null,
            permissions: null,
          },
        ],
      });
      expect(result.type).toBe('ALL');
    });
  });

  describe('GET /users/me/access', () => {
    it('retourne les entries du current user', async () => {
      const entries = [
        {
          id: ACCESS_ID,
          accessType: AccessType.GROUP,
          groupId: GROUP_ID,
          vehicleId: null,
          permissions: { engine_control: true },
          createdAt: new Date(),
          updatedAt: new Date(),
          group: { id: GROUP_ID, name: 'Nuit', vehicles: [{ vehicleId: VEHICLE_ID }] },
          vehicle: null,
        },
      ];
      const accessFindMany = jest.fn().mockResolvedValue(entries);
      const prisma = makePrisma({ accessFindMany });

      const result = await makeController(prisma).getMyAccess(makeReq(UserRole.VIEWER));

      expect(accessFindMany).toHaveBeenCalledWith({
        where: { userId: ADMIN_ID }, // ADMIN_ID est le current user ici
        select: expect.any(Object),
      });
      expect(result.entries).toEqual(entries);
    });
  });

  describe('GET /users/:id — anti oracle cross-fleet (#33)', () => {
    it('renvoie 404 (pas 403 ni 200/null) pour un user inexistant OU d une autre flotte', async () => {
      // Le filtre tenant est integre au where (findFirst) -> un user d'une autre
      // flotte ressort `null`, indistinguable d'un user inexistant -> meme 404.
      const prisma = makePrisma({ userFindFirst: jest.fn().mockResolvedValue(null) });
      await expect(
        makeController(prisma).findOne(USER_ID, makeReq(UserRole.FLEET_ADMIN, FLEET_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('SUPER_ADMIN peut lire un user de n importe quelle flotte (pas de filtre)', async () => {
      const userFindFirst = jest.fn().mockResolvedValue({ id: USER_ID, fleetId: OTHER_FLEET_ID });
      const prisma = makePrisma({ userFindFirst });
      const res = await makeController(prisma).findOne(USER_ID, makeReq(UserRole.SUPER_ADMIN, null));
      expect(res).toMatchObject({ id: USER_ID });
      expect(userFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: USER_ID } }));
    });
  });
});
