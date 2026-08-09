import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { DepotScopeGuard } from './depot-scope.guard';
import type { DepotScopeSpec } from './depot-scope.decorator';
import type { DepotScopeService } from './depot-scope.service';

/**
 * Le garde qui borne un compte DEPOT. Ce qu'on protege ici :
 *   - les autres roles ne sont pas affectes ;
 *   - l'absence de declaration FERME la route (default-deny) ;
 *   - inconnu et hors-perimetre sont indiscernables.
 */
describe('DepotScopeGuard', () => {
  let garde: DepotScopeGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let scope: jest.Mocked<Pick<DepotScopeService, 'canSeeMission' | 'canSeeLivePosition' | 'canSeeTrip'>>;

  const contexte = (user: unknown, params: Record<string, unknown> = {}): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user, params, body: {}, query: {} }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as unknown as ExecutionContext;

  const DEPOT = { id: 'depot-1', role: UserRole.DEPOT };

  const declare = (spec: DepotScopeSpec | undefined) =>
    reflector.getAllAndOverride.mockReturnValue(spec);

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    scope = {
      canSeeMission: jest.fn(),
      canSeeLivePosition: jest.fn(),
      canSeeTrip: jest.fn(),
    } as never;
    garde = new DepotScopeGuard(reflector as unknown as Reflector, scope as unknown as DepotScopeService);
  });

  describe('les autres roles passent sans etre interroges', () => {
    it.each([
      UserRole.SUPER_ADMIN,
      UserRole.FLEET_ADMIN,
      UserRole.FLEET_MANAGER,
      UserRole.VIEWER,
      UserRole.NIGHT_WATCHMAN,
      UserRole.DRIVER,
    ])('%s traverse le garde', async (role) => {
      declare(undefined);
      await expect(garde.canActivate(contexte({ id: 'u', role }))).resolves.toBe(true);
      expect(scope.canSeeMission).not.toHaveBeenCalled();
    });

    it('une requete sans user traverse (les gardes d\'auth s\'en chargent)', async () => {
      declare(undefined);
      await expect(garde.canActivate(contexte(undefined))).resolves.toBe(true);
    });
  });

  describe('default-deny — un oubli ferme, il n\'ouvre pas', () => {
    it('aucune declaration de perimetre sur une route atteinte par un DEPOT → 403', async () => {
      // L'invariant qui compte le plus de tout le lot. Si l'absence de decorateur
      // laissait passer, chaque nouvelle route serait ouverte au depot par defaut,
      // et une seule omission suffirait a tout ouvrir.
      declare(undefined);
      await expect(garde.canActivate(contexte(DEPOT))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('parametre attendu mais absent → 403', async () => {
      declare({ kind: 'mission', paramName: 'id' });
      await expect(garde.canActivate(contexte(DEPOT, {}))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('resolution du perimetre', () => {
    it('kind=mission interroge canSeeMission', async () => {
      declare({ kind: 'mission', paramName: 'id' });
      scope.canSeeMission.mockResolvedValue(true);
      await expect(garde.canActivate(contexte(DEPOT, { id: 'm-1' }))).resolves.toBe(true);
      expect(scope.canSeeMission).toHaveBeenCalledWith('depot-1', 'm-1');
    });

    it('kind=vehiclePosition interroge canSeeLivePosition', async () => {
      declare({ kind: 'vehiclePosition', paramName: 'vehicleId' });
      scope.canSeeLivePosition.mockResolvedValue(true);
      await expect(garde.canActivate(contexte(DEPOT, { vehicleId: 'v-1' }))).resolves.toBe(true);
      expect(scope.canSeeLivePosition).toHaveBeenCalledWith('depot-1', 'v-1');
    });

    it('kind=trip interroge canSeeTrip', async () => {
      declare({ kind: 'trip', paramName: 'id' });
      scope.canSeeTrip.mockResolvedValue(true);
      await expect(garde.canActivate(contexte(DEPOT, { id: 't-1' }))).resolves.toBe(true);
      expect(scope.canSeeTrip).toHaveBeenCalledWith('depot-1', 't-1');
    });

    it('kind=none passe sans interroger (le service porte deja depotUserId)', async () => {
      declare({ kind: 'none' });
      await expect(garde.canActivate(contexte(DEPOT))).resolves.toBe(true);
      expect(scope.canSeeMission).not.toHaveBeenCalled();
    });

    it('hors perimetre → 403', async () => {
      declare({ kind: 'mission', paramName: 'id' });
      scope.canSeeMission.mockResolvedValue(false);
      await expect(garde.canActivate(contexte(DEPOT, { id: 'm-autre' }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('inconnu et hors-perimetre sont indiscernables', () => {
    it('meme code et meme message dans les trois cas de refus', async () => {
      // Distinguer 404 (inconnu) et 403 (hors perimetre) permettrait d'ENUMERER les
      // identifiants valides : on demande, et le code de retour repond. D'ou un
      // unique ForbiddenException au libelle neutre (A1 § 3, regle 3).
      const messages: string[] = [];

      declare(undefined);
      await garde.canActivate(contexte(DEPOT)).catch((e: Error) => messages.push(e.message));

      declare({ kind: 'mission', paramName: 'id' });
      await garde.canActivate(contexte(DEPOT, {})).catch((e: Error) => messages.push(e.message));

      scope.canSeeMission.mockResolvedValue(false);
      await garde
        .canActivate(contexte(DEPOT, { id: 'inconnu' }))
        .catch((e: Error) => messages.push(e.message));

      expect(messages).toHaveLength(3);
      expect(new Set(messages).size).toBe(1);
      // Le message ne nomme ni la ressource, ni la raison du refus.
      expect(messages[0]).not.toMatch(/mission|trajet|vehicule|introuvable|existe/i);
    });
  });

  describe('extraction du parametre', () => {
    it('lit params en priorite, puis body, puis query', async () => {
      declare({ kind: 'mission', paramName: 'id' });
      scope.canSeeMission.mockResolvedValue(true);
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({
            user: DEPOT,
            params: {},
            body: { id: 'depuis-body' },
            query: { id: 'depuis-query' },
          }),
        }),
        getHandler: () => undefined,
        getClass: () => undefined,
      } as unknown as ExecutionContext;
      await garde.canActivate(ctx);
      expect(scope.canSeeMission).toHaveBeenCalledWith('depot-1', 'depuis-body');
    });
  });
});
