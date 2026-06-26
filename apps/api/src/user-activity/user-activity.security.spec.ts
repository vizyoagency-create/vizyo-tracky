import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserActivityController } from './user-activity.controller';

/**
 * Sécurité des endpoints admin d'activité — en particulier le NOUVEL endpoint
 * GET /admin/activity/engine-commands (historique des coupures/redémarrages
 * moteur). Il DOIT être SUPER_ADMIN uniquement et refuser tout autre rôle —
 * surtout le veilleur (NIGHT_WATCHMAN). Ajouté en review à froid (2026-06-26),
 * cf [[prod-merge-review-process]] : ces deux features étaient parties en prod
 * sans gate review.
 *
 * On teste l'enforcement RÉEL (pas juste déclaré) :
 *  (1) le @Roles réellement posé sur chaque handler de lecture admin,
 *  (2) que @UseGuards(RolesGuard) est BIEN câblé sur la méthode — sinon @Roles
 *      serait un no-op (le piège copy-paste : copier @Roles sans le guard),
 *  (3) que RolesGuard refuse (403) le veilleur + tout non-super.
 */

// NestJS stocke les guards via cette clé de métadonnée (constante interne).
const GUARDS_METADATA = '__guards__';
const SA = UserRole.SUPER_ADMIN;
const NW = UserRole.NIGHT_WATCHMAN;

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

function rolesOf(method: string): UserRole[] {
  const target = (UserActivityController.prototype as unknown as Record<string, unknown>)[method] as object;
  return (Reflect.getMetadata(ROLES_KEY, target) ?? []) as UserRole[];
}

function methodGuards(method: string): unknown[] {
  const target = (UserActivityController.prototype as unknown as Record<string, unknown>)[method] as object;
  return (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];
}

describe('Sécurité endpoints admin/activity (dont engine-commands)', () => {
  // Tous les endpoints de LECTURE admin doivent être verrouillés pareil.
  const ADMIN_READS = ['online', 'feed', 'stats', 'engineCommands'];

  it('la classe UserActivityController est gardée par JwtAuthGuard (auth requise)', () => {
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, UserActivityController) ?? []) as unknown[];
    expect(classGuards).toContain(JwtAuthGuard);
  });

  it.each(ADMIN_READS)('%s : @Roles === [SUPER_ADMIN] (et surtout PAS NIGHT_WATCHMAN)', (method) => {
    const roles = rolesOf(method);
    expect(roles).toEqual([SA]);
    expect(roles).not.toContain(NW);
  });

  it.each(ADMIN_READS)('%s : @UseGuards(RolesGuard) est bien câblé (sinon @Roles = no-op)', (method) => {
    expect(methodGuards(method)).toContain(RolesGuard);
  });

  it('engine-commands : RolesGuard REFUSE le veilleur ET tout non-super (403)', () => {
    // On part des @Roles RÉELS de l'endpoint (= [SUPER_ADMIN]) et on prouve le refus.
    const guard = rolesGuardReturning(rolesOf('engineCommands'));
    for (const role of [NW, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER]) {
      expect(() => guard.canActivate(ctxWithUser(role))).toThrow(ForbiddenException);
    }
  });

  it('engine-commands : RolesGuard AUTORISE le SUPER_ADMIN', () => {
    const guard = rolesGuardReturning(rolesOf('engineCommands'));
    expect(guard.canActivate(ctxWithUser(SA))).toBe(true);
  });
});
