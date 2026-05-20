import { SetMetadata } from '@nestjs/common';
import type { UserPermissions } from '../../users/default-permissions';

/**
 * V1.10 (Sprint 6) — Decorator pour exiger une ou plusieurs permissions sur
 * une route. A combiner avec @UseGuards(..., PermissionsGuard).
 *
 * Exemple :
 *   @Post()
 *   @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
 *   @RequirePermissions('vehicles_create')
 *   create(...) { ... }
 *
 * Note : SUPER_ADMIN et FLEET_ADMIN bypass ce check (decision metier — leurs
 * permissions JSON sont alignees sur FLEET_MANAGER mais leur role les autorise
 * a tout faire). Le check est donc pertinent pour FLEET_MANAGER / VIEWER /
 * roles futurs avec permissions personnalisees.
 */
export const PERMISSIONS_KEY = 'required-permissions';

export const RequirePermissions = (...permissions: Array<keyof UserPermissions>) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
