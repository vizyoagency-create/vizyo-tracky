import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import type { UserPermissions } from '@vizyo/tracky-shared';
import { PermissionsService } from '../services/permissions.service';

/**
 * V1.11 Phase 1 — Guard de route factory : exige une permission globale.
 *
 * Exemple :
 *   { path: 'groups', canActivate: [permissionGuard('groups_view')], ... }
 *
 * Admins (SUPER_ADMIN, FLEET_ADMIN) bypass via PermissionsService.can.
 * Redirige vers /dashboard si refus (UX coherent avec superAdminGuard).
 */
export function permissionGuard(permission: keyof UserPermissions): CanActivateFn {
  return () => {
    const perms = inject(PermissionsService);
    const router = inject(Router);
    if (perms.can(permission)) return true;
    return router.createUrlTree(['/dashboard']);
  };
}

/**
 * Sprint 8 — variante « au moins une » : autorise si l'user détient l'UNE des permissions.
 * Ex. /reservations accessible à qui peut VOIR ou DEMANDER (un grant request-only doit entrer).
 */
export function anyPermissionGuard(...permissions: (keyof UserPermissions)[]): CanActivateFn {
  return () => {
    const perms = inject(PermissionsService);
    const router = inject(Router);
    if (permissions.some((p) => perms.can(p))) return true;
    return router.createUrlTree(['/dashboard']);
  };
}
