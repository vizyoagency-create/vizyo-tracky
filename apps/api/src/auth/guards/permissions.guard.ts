import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import type { UserPermissions } from '../../users/default-permissions';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * V1.10 (Sprint 6) — Enforcement backend du champ `User.permissions`.
 *
 * Avant : les permissions JSON etaient UI-only — un FLEET_MANAGER avec
 * `vehicles_create: false` voyait juste le bouton cache cote frontend, mais
 * pouvait toujours hit POST /api/vehicles directement. Cette guard ferme cette
 * porte en validant les metadata @RequirePermissions a chaque requete.
 *
 * Application : annoter les routes critiques avec @RequirePermissions(...keys)
 * en plus de @Roles. Le PermissionsGuard est applique apres JwtAuthGuard + RolesGuard
 * via @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard).
 *
 * SUPER_ADMIN et FLEET_ADMIN bypass — leur role les autorise a tout, leurs
 * permissions sont juste un defaults source pour les autres users de la flotte.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Array<keyof UserPermissions> | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;

    // SUPER_ADMIN et FLEET_ADMIN ont tous les droits (decision metier).
    if (user.role === UserRole.SUPER_ADMIN || user.role === UserRole.FLEET_ADMIN) return true;

    const perms = (user.permissions ?? {}) as Partial<Record<keyof UserPermissions, boolean>>;
    for (const key of required) {
      if (!perms[key]) {
        throw new ForbiddenException(`Permission requise : ${String(key)}`);
      }
    }
    return true;
  }
}
