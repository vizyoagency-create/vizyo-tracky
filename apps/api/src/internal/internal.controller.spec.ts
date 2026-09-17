import { ConflictException, UnauthorizedException } from '@nestjs/common';
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
      // Lot A (C3) : la provision cherche d'abord un admin deja connu — aucun par defaut.
      findFirst: jest.fn().mockResolvedValue(null),
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
  // La transaction interactive rejoue les memes mocks : on verifie la SEQUENCE et l'atomicite
  // par le fait meme qu'elle passe par `$transaction`.
  (prisma as unknown as { $transaction: unknown }).$transaction = jest.fn(async (fn: (tx: PrismaService) => Promise<unknown>) => fn(prisma));
  (prisma as unknown as { fleet: { update: unknown } }).fleet.update = jest.fn().mockResolvedValue({});

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

  // Lot D : la synchronisation Manager → Tracky vit dans FleetSyncService (testé à part).
  const fleetSync = { unlinked: jest.fn(), patch: jest.fn(), put: jest.fn(), archive: jest.fn(), unarchive: jest.fn(), destroy: jest.fn() };

  return {
    controller: new InternalController(prisma, authClient, accountSync as never, systemActivity, fleetSync as never),
    prisma,
    accountSync,
    fleetSync,
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
  describe('lot D — routes de synchronisation', () => {
    it('GET fleets exige ?unlinked=true (la seule liste servie aux machines)', async () => {
      const { controller, fleetSync } = createController();
      await expect(controller.listFleets(undefined)).rejects.toBeInstanceOf(ConflictException);
      fleetSync.unlinked.mockResolvedValue([]);
      await expect(controller.listFleets('true')).resolves.toEqual([]);
    });

    it('PATCH / PUT / archive / unarchive / DELETE délèguent au service avec le bon identifiant', async () => {
      const { controller, fleetSync } = createController();
      await controller.patchFleet('f1', { name: 'X' });
      expect(fleetSync.patch).toHaveBeenCalledWith('f1', { name: 'X' });
      await controller.putFleet('f1', { name: 'X', clientId: 'c1' });
      expect(fleetSync.put).toHaveBeenCalledWith('f1', { name: 'X', clientId: 'c1' });
      await controller.archiveFleet('f1', { by: 'op' });
      expect(fleetSync.archive).toHaveBeenCalledWith('f1', { by: 'op' });
      await controller.unarchiveFleet('f1', undefined as never);
      expect(fleetSync.unarchive).toHaveBeenCalledWith('f1', {});
      await controller.destroyFleet('f1', { confirmName: 'X' });
      expect(fleetSync.destroy).toHaveBeenCalledWith('f1', { confirmName: 'X' });
    });
  });

  /**
   * LA PROVISION PAR VIZYO MANAGER — lot A de la conception RDV v2 (C1–C3).
   *
   * Avant : flotte creee PUIS admin, hors transaction (un e-mail deja pris laissait une flotte
   * orpheline), rejouable a l'infini (une flotte de plus a chaque essai), sans `clientId`
   * ni telephone.
   */
  describe('provisionFleet', () => {
    it('cree la flotte et son admin dans UNE transaction, avec le client Manager et le contact (C1, C2, C3)', async () => {
      const { controller, prisma } = createController();
      const result = await controller.provisionFleet({
        fleetName: ' Test Fleet ',
        clientId: 'cli-42',
        adminAuthUserId: 'auth-001',
        adminEmail: 'Admin@Fleet.com',
        adminFirstName: 'John',
        adminLastName: 'Doe',
        adminPhone: '06 12 34 56 78',
      });

      expect(result).toEqual({ fleetId: 'fleet-001', existed: false });
      expect((prisma as unknown as { $transaction: jest.Mock }).$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.fleet.create).toHaveBeenCalledWith({
        data: { name: 'Test Fleet', clientId: 'cli-42', managedByManagerAt: expect.any(Date) },
      });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: {
          authUserId: 'auth-001',
          email: 'admin@fleet.com',
          firstName: 'John',
          lastName: 'Doe',
          phone: '+33612345678',
          role: UserRole.FLEET_ADMIN,
          fleetId: 'fleet-001',
          // Lot D : identité pilotée par Manager dès la provision.
          managedByManager: true,
        },
      });
    });

    it('sans clientId ni contact : la flotte naît quand même (Manager d’avant le lot D)', async () => {
      const { controller, prisma } = createController();
      await controller.provisionFleet({ fleetName: 'Test Fleet', adminAuthUserId: 'auth-001', adminEmail: 'admin@fleet.com' });
      expect(prisma.fleet.create).toHaveBeenCalledWith({ data: { name: 'Test Fleet', clientId: null, managedByManagerAt: expect.any(Date) } });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ firstName: null, lastName: null, phone: null }),
      });
    });

    it('IDEMPOTENT : un admin deja connu (meme e-mail ou meme compte Auth) rend SA flotte, sans rien creer', async () => {
      const { controller, prisma } = createController();
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'u9', email: 'admin@fleet.com', fleetId: 'fleet-009', role: UserRole.FLEET_ADMIN });
      (prisma.fleet as unknown as { findUnique: jest.Mock }).findUnique = jest.fn().mockResolvedValue({ name: 'test fleet', clientId: null });
      const result = await controller.provisionFleet({
        fleetName: 'Test Fleet', clientId: 'cli-42', adminAuthUserId: 'auth-001', adminEmail: 'admin@fleet.com',
      });
      expect(result).toEqual({ fleetId: 'fleet-009', existed: true });
      expect(prisma.fleet.create).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      // Le client Manager, lui, est recolle si on le connait enfin.
      expect((prisma.fleet as unknown as { update: jest.Mock }).update).toHaveBeenCalledWith({ where: { id: 'fleet-009' }, data: { clientId: 'cli-42', managedByManagerAt: expect.any(Date) } });
    });

    it('🔴 un e-mail deja admin d\'une AUTRE societe (nom different) → 409 nommant la flotte : jamais un client rattache a la societe d\'un autre', async () => {
      const { controller, prisma } = createController();
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'u9', email: 'admin@fleet.com', fleetId: 'fleet-009', role: UserRole.FLEET_ADMIN });
      (prisma.fleet as unknown as { findUnique: jest.Mock }).findUnique = jest.fn().mockResolvedValue({ name: 'Transports Legrand', clientId: null });
      await expect(controller.provisionFleet({ fleetName: 'Garage Martin', clientId: 'cli-42', adminAuthUserId: 'auth-001', adminEmail: 'admin@fleet.com' }))
        .rejects.toThrow(/Transports Legrand/);
      expect(prisma.fleet.create).not.toHaveBeenCalled();
    });

    it('🔴 un compte simple membre (VIEWER) d\'une flotte → 409 ; une flotte deja reliee a un autre client → 409', async () => {
      const { controller, prisma } = createController();
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'u9', email: 'admin@fleet.com', fleetId: 'fleet-009', role: UserRole.VIEWER });
      (prisma.fleet as unknown as { findUnique: jest.Mock }).findUnique = jest.fn().mockResolvedValue({ name: 'Test Fleet', clientId: null });
      await expect(controller.provisionFleet({ fleetName: 'Test Fleet', adminAuthUserId: 'auth-001', adminEmail: 'admin@fleet.com' }))
        .rejects.toThrow(/membre \(VIEWER\)/);
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'u9', email: 'admin@fleet.com', fleetId: 'fleet-009', role: UserRole.FLEET_ADMIN });
      (prisma.fleet as unknown as { findUnique: jest.Mock }).findUnique = jest.fn().mockResolvedValue({ name: 'Test Fleet', clientId: 'cli-autre' });
      await expect(controller.provisionFleet({ fleetName: 'Test Fleet', clientId: 'cli-42', adminAuthUserId: 'auth-001', adminEmail: 'admin@fleet.com' }))
        .rejects.toThrow(/autre client Manager/);
    });

    it('un compte connu SANS flotte → 409 : on ne devine pas a quelle flotte le rattacher', async () => {
      const { controller, prisma } = createController();
      (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 'u9', email: 'admin@fleet.com', fleetId: null, role: UserRole.VIEWER });
      await expect(controller.provisionFleet({ fleetName: 'Test Fleet', adminAuthUserId: 'auth-001', adminEmail: 'admin@fleet.com' }))
        .rejects.toBeInstanceOf(ConflictException);
      expect(prisma.fleet.create).not.toHaveBeenCalled();
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
