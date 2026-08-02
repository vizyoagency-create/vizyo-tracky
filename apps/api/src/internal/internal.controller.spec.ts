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
      // Les membres de la flotte, LUS avant la bascule pour pouvoir propager le statut
      // a Vizyo Auth. Un fixture sans `authUserId` ferait passer le test sans jamais
      // exercer la propagation — le defaut qu'on repare.
      findMany: jest.fn().mockResolvedValue([
        { id: 'u1', email: 'a@fleet.com', authUserId: 'auth-1' },
        { id: 'u2', email: 'b@fleet.com', authUserId: 'auth-2' },
        { id: 'u3', email: 'c@fleet.com', authUserId: null },
      ]),
    },
  } as unknown as PrismaService;

  const authClient = {
    register: jest.fn(),
    login: jest.fn(),
    removeUserFromApp: jest.fn(),
  } as unknown as import('../auth-client/auth-client.service').AuthClientService;

  const systemActivity = { record: jest.fn() } as unknown as import('../system-activity/system-activity.service').SystemActivityService;

  // Synchro de statut vers Vizyo Auth. Renvoie `true` (succes) par defaut : les tests
  // existants verifient l'ecriture Tracky, pas la propagation. Les tests dedies a la
  // propagation, eux, pilotent ce mock explicitement.
  const accountSync = { applyStatus: jest.fn().mockResolvedValue(true) };

  return {
    controller: new InternalController(prisma, authClient, accountSync as never, systemActivity),
    prisma,
    accountSync,
  };
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

  /**
   * LE KILL-SWITCH CLIENT — il ne coupait pas le login.
   *
   * `suspendFleet` basculait `isActive` en masse dans Tracky sans rien dire a Vizyo Auth,
   * qui est la SEULE autorite du login. Une flotte « suspendue » gardait donc des comptes
   * parfaitement capables de se connecter : exactement l'inverse de ce que Manager croit
   * declencher. Meme defaut que l'archivage individuel, a l'echelle d'un client entier.
   */
  describe('suspendFleet', () => {
    it('desactive les comptes cote Tracky', async () => {
      const { controller, prisma } = createController();
      const result = await controller.suspendFleet({ fleetId: 'fleet-001' });

      expect(result).toMatchObject({ status: 'suspended' });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { fleetId: 'fleet-001' },
        data: { isActive: false },
      });
    });

    it('⚠️ SUSPEND AUSSI dans Vizyo Auth — sinon le login reste ouvert', async () => {
      const { controller, accountSync } = createController();
      await controller.suspendFleet({ fleetId: 'fleet-001' });

      // Les trois membres sont traites, y compris celui SANS identifiant Auth : c'est le
      // service qui decide quoi en faire, pas l'appelant (sinon la regle se dedouble).
      expect(accountSync.applyStatus).toHaveBeenCalledTimes(3);
      expect(accountSync.applyStatus).toHaveBeenCalledWith('auth-1', false, expect.stringContaining('fleet_suspend'));
      expect(accountSync.applyStatus).toHaveBeenCalledWith('auth-2', false, expect.stringContaining('fleet_suspend'));
      expect(accountSync.applyStatus).toHaveBeenCalledWith(null, false, expect.stringContaining('fleet_suspend'));
    });

    it('⚠️ REMONTE le nombre d echecs — un kill-switch a moitie applique doit se voir', async () => {
      // Le pire cas d'un kill-switch, c'est de croire qu'il a fonctionne. On compte les
      // refus de Vizyo Auth et on les renvoie a Manager AUTANT qu'on les journalise.
      const { controller, accountSync } = createController();
      accountSync.applyStatus
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);

      const result = await controller.suspendFleet({ fleetId: 'fleet-001' });
      expect(result).toMatchObject({ status: 'suspended', authFailures: 2 });
    });

    it('un echec de propagation n empeche PAS la desactivation Tracky', async () => {
      // Ordre voulu : Tracky d'abord, propagation ensuite. Une panne de Vizyo Auth ne doit
      // pas laisser un client actif alors qu'on a demande sa suspension.
      const { controller, prisma, accountSync } = createController();
      accountSync.applyStatus.mockResolvedValue(false);

      await controller.suspendFleet({ fleetId: 'fleet-001' });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { fleetId: 'fleet-001' },
        data: { isActive: false },
      });
    });
  });

  describe('activateFleet', () => {
    it('reactive les comptes cote Tracky', async () => {
      const { controller, prisma } = createController();
      const result = await controller.activateFleet({ fleetId: 'fleet-001' });

      expect(result).toMatchObject({ status: 'active' });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { fleetId: 'fleet-001' },
        data: { isActive: true },
      });
    });

    it('⚠️ REACTIVE aussi dans Vizyo Auth — sinon la flotte reste bloquee au login', async () => {
      // Symetrique du kill-switch. Sans lui, reactiver un client le laisserait verrouille
      // tout en s'affichant actif : le support cherche du cote de Tracky, ou tout va bien.
      const { controller, accountSync } = createController();
      await controller.activateFleet({ fleetId: 'fleet-001' });

      expect(accountSync.applyStatus).toHaveBeenCalledTimes(3);
      expect(accountSync.applyStatus).toHaveBeenCalledWith('auth-1', true, expect.stringContaining('fleet_activate'));
    });
  });
});
