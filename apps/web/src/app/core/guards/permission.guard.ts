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
