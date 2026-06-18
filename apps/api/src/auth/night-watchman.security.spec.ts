import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import {
  clampPermissions,
  getDefaultPermissions,
  PERMISSION_KEYS,
  type UserPermissions,
} from '@vizyo/tracky-shared';
import type { AuthUser } from './types/auth-user';
import { ROLES_KEY } from './decorators/roles.decorator';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import type { PrismaService } from '../prisma/prisma.service';
// Controllers reels — pour reflechir les @Roles effectivement deployes.
import { VehiclesController } from '../vehicles/vehicles.controller';
import { EngineControlController } from '../engine-control/engine-control.controller';
import { AlertsController } from '../alerts/alerts.controller';
import { ReportsController } from '../reports/reports.controller';
import { DriversController } from '../drivers/drivers.controller';
import { GeofencesController } from '../geofences/geofences.controller';
import { VehicleSchedulesController } from '../vehicle-schedules/vehicle-schedules.controller';
import { TripsController } from '../trips/trips.controller';

/**
 * Sprint 3 — Sécurité du rôle « veilleur de nuit » (NIGHT_WATCHMAN).
 *
 * Le veilleur ne doit pouvoir QUE : voir ses véhicules (scopés) + couper/
 * redémarrer le moteur (per-véhicule, scopé). Tout le reste = 403, enforcement
 * SERVEUR, scoping tenant strict, zéro escalade de privilège.
 *
 * Ces tests prouvent l'enforcement au niveau des MÉCANISMES réels (RolesGuard,
 * PermissionsResolver, clamp) + reflètent les `@Roles` réellement posés sur les
 * controllers. Ils échouent si un futur changement élargit le périmètre veilleur.
 */

const NW = UserRole.NIGHT_WATCHMAN;

function makeUser(partial: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'nw-user-1',
    role: NW,
    fleetId: 'fleet-1',
    permissions: null,
    ...partial,
  } as unknown as AuthUser;
}

function ctxWithUser(role: UserRole): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function rolesGuardReturning(roles: UserRole[] | undefined): RolesGuard {
  const reflector = { getAllAndOverride: () => roles } as unknown as Reflector;
  return new RolesGuard(reflector);
}

/** Lit le tableau @Roles posé sur une méthode de controller (ou [] si absent). */
function rolesOf(ctrl: { prototype: object }, method: string): UserRole[] {
  const target = (ctrl.prototype as Record<string, unknown>)[method] as object;
  return (Reflect.getMetadata(ROLES_KEY, target) ?? []) as UserRole[];
}

/** Toutes les listes @Roles posées sur les handlers d'un controller. */
function allRoleSets(ctrl: { prototype: object }): Array<{ method: string; roles: UserRole[] }> {
  const proto = ctrl.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((m) => m !== 'constructor' && typeof proto[m] === 'function')
    .map((m) => ({ method: m, roles: rolesOf(ctrl, m) }));
}

describe('Sprint 3 — Sécurité veilleur de nuit (NIGHT_WATCHMAN)', () => {
  describe('A. Périmètre par défaut (catalogue de permissions)', () => {
    it('défauts NIGHT_WATCHMAN = strictement vehicles_view + engine_control (rien d’autre)', () => {
      const perms = getDefaultPermissions('NIGHT_WATCHMAN');
      const allowed: (keyof UserPermissions)[] = ['vehicles_view', 'engine_control'];
      for (const key of PERMISSION_KEYS) {
        expect({ key, value: perms[key] }).toEqual({ key, value: allowed.includes(key) });
      }
      // En particulier : aucune capacité d'administration, ni horaires par défaut.
      expect(perms.schedules_manage).toBe(false);
      expect(perms.users_manage).toBe(false);
      expect(perms.alerts_view).toBe(false);
      expect(perms.reports_view).toBe(false);
      expect(perms.geofences_view).toBe(false);
      expect(perms.drivers_view).toBe(false);
      expect(perms.sims_view).toBe(false);
      expect(perms.vehicles_delete).toBe(false);
    });
  });

  describe('B. RolesGuard — 403 sur toute forme de @Roles hors-périmètre', () => {
    // Les 5 formes distinctes de @Roles présentes dans l'API (cf. audit endpoints).
    // NIGHT_WATCHMAN n'est dans AUCUNE → RolesGuard doit refuser (403) à chaque fois.
    const OUT_OF_PERIMETER: Array<{ label: string; roles: UserRole[] }> = [
      {
        label: '[FA,SA,FM,VIEWER] (alerts, geofences, trips, drivers, trackers, sims, reports, positions, groups…)',
        roles: [UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER],
      },
      {
        label: '[FA,SA,FM] (engine GET commands, schedules GET, surveillance, alerts ack, invitations…)',
        roles: [UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER],
      },
      {
        label: '[FA,SA] (schedules PUT, users CRUD, groups CUD, geofences import…)',
        roles: [UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN],
      },
      {
        label: '[SA,FA] (sampling, fix-mode, installations…)',
        roles: [UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN],
      },
      {
        label: '[SA] (sims admin, sms admin, observability, system-metrics…)',
        roles: [UserRole.SUPER_ADMIN],
      },
    ];

    it.each(OUT_OF_PERIMETER)('refuse le veilleur sur $label', ({ roles }) => {
      const guard = rolesGuardReturning(roles);
      expect(() => guard.canActivate(ctxWithUser(NW))).toThrow(ForbiddenException);
    });

    it('autorise le veilleur sur les listes IN-périmètre (vehicles GET + engine POST)', () => {
      const inPerimeter: UserRole[] = [
        UserRole.FLEET_ADMIN,
        UserRole.SUPER_ADMIN,
        UserRole.FLEET_MANAGER,
        UserRole.VIEWER,
        UserRole.NIGHT_WATCHMAN,
      ];
      expect(rolesGuardReturning(inPerimeter).canActivate(ctxWithUser(NW))).toBe(true);
    });
  });

  describe('C. Scoping per-véhicule (engine_control) — zéro escalade hors-scope', () => {
    function makeResolver(findManyImpl: jest.Mock) {
      const prisma = {
        userVehicleAccess: { findMany: findManyImpl },
      } as unknown as PrismaService;
      return new PermissionsResolverService(prisma);
    }

    it('véhicule DANS le scope (règle GROUP, perms null → défauts veilleur) → engine_control autorisé', async () => {
      const findMany = jest.fn().mockResolvedValue([{ accessType: 'GROUP', permissions: null }]);
      const resolver = makeResolver(findMany);
      const ok = await resolver.canOnVehicle(makeUser(), 'veh-in-scope', 'engine_control');
      expect(ok).toBe(true);
    });

    it('véhicule HORS scope (aucune règle ne le couvre) → resolveForVehicle=null → engine_control REFUSÉ', async () => {
      // C'est LE test anti-fuite : malgré engine_control=true dans les défauts du
      // rôle, un véhicule non couvert par une règle UserVehicleAccess est refusé
      // (pas de fallback sur les permissions globales pour les actions per-véhicule).
      const findMany = jest.fn().mockResolvedValue([]);
      const resolver = makeResolver(findMany);
      const user = makeUser();
      expect(await resolver.resolveForVehicle(user, 'veh-out-of-scope')).toBeNull();
      expect(await resolver.canOnVehicle(user, 'veh-out-of-scope', 'engine_control')).toBe(false);
    });

    it('véhicule dans le scope mais override permissions {engine_control:false} → spécifique gagne → REFUSÉ', async () => {
      const findMany = jest
        .fn()
        .mockResolvedValue([{ accessType: 'VEHICLE', permissions: { engine_control: false } }]);
      const resolver = makeResolver(findMany);
      const ok = await resolver.canOnVehicle(makeUser(), 'veh-denied', 'engine_control');
      expect(ok).toBe(false);
    });
  });

  describe('D. Anti-escalade de privilège (clampPermissions)', () => {
    it('un granter FLEET_MANAGER (sans engine_control) NE PEUT PAS créer un veilleur avec engine_control', () => {
      const granter = { role: 'FLEET_MANAGER' as const, permissions: getDefaultPermissions('FLEET_MANAGER') };
      const clamped = clampPermissions(
        { engine_control: true, schedules_manage: true, users_manage: true },
        granter,
        getDefaultPermissions('NIGHT_WATCHMAN'),
      );
      expect(clamped.engine_control).toBe(false); // FM ne l'a pas → ne peut l'accorder
      expect(clamped.users_manage).toBe(false); // FM ne l'a pas
      expect(clamped.schedules_manage).toBe(true); // FM l'a (défauts) → peut l'accorder
    });

    it('un granter FLEET_ADMIN PEUT accorder engine_control au veilleur (bypass = toutes perms)', () => {
      const granter = { role: 'FLEET_ADMIN' as const, permissions: null };
      const clamped = clampPermissions(
        { engine_control: true },
        granter,
        getDefaultPermissions('NIGHT_WATCHMAN'),
      );
      expect(clamped.engine_control).toBe(true);
    });
  });

  describe('E. Reflet des @Roles réellement posés sur les controllers', () => {
    it('IN-périmètre : NIGHT_WATCHMAN présent UNIQUEMENT sur vehicles lecture + engine POST', () => {
      expect(rolesOf(VehiclesController, 'snapshot')).toContain(NW);
      expect(rolesOf(VehiclesController, 'findAll')).toContain(NW);
      expect(rolesOf(VehiclesController, 'findOne')).toContain(NW);
      expect(rolesOf(EngineControlController, 'requestCommand')).toContain(NW);
    });

    it('vehicles : écritures + stats NE contiennent PAS le veilleur', () => {
      for (const m of ['create', 'update', 'remove', 'setGroup', 'assignDriver', 'stats']) {
        expect(rolesOf(VehiclesController, m)).not.toContain(NW);
      }
    });

    it('engine-control : GET commands/getCommand NE contiennent PAS le veilleur', () => {
      expect(rolesOf(EngineControlController, 'listCommands')).not.toContain(NW);
      expect(rolesOf(EngineControlController, 'getCommand')).not.toContain(NW);
    });

    it('controllers sensibles : AUCUN handler ne liste NIGHT_WATCHMAN', () => {
      const sensitive = [
        ['AlertsController', AlertsController],
        ['ReportsController', ReportsController],
        ['DriversController', DriversController],
        ['GeofencesController', GeofencesController],
        ['VehicleSchedulesController', VehicleSchedulesController],
        ['TripsController', TripsController],
      ] as const;
      for (const [name, ctrl] of sensitive) {
        for (const { method, roles } of allRoleSets(ctrl)) {
          expect({ name, method, hasNW: roles.includes(NW) }).toEqual({ name, method, hasNW: false });
        }
      }
    });
  });
});
