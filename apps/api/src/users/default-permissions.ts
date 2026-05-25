/**
 * Backward-compat wrapper — la source de verite est `@vizyo/tracky-shared`.
 *
 * On garde ce module pour ne pas casser les imports relatifs existants
 * (`../users/default-permissions`). Les nouveaux fichiers DOIVENT importer
 * directement depuis `@vizyo/tracky-shared`. A retirer dans une PR
 * ulterieure une fois tous les consommateurs migres.
 */
import { UserRole } from '@prisma/client';
import {
  getDefaultPermissions as getSharedDefaultPermissions,
  PERMISSION_KEYS as SHARED_PERMISSION_KEYS,
  type UserPermissions as SharedUserPermissions,
  type UserRoleSlug,
} from '@vizyo/tracky-shared';

export type UserPermissions = SharedUserPermissions;
export const PERMISSION_KEYS = SHARED_PERMISSION_KEYS;

export function getDefaultPermissions(role: UserRole): UserPermissions {
  return getSharedDefaultPermissions(role as UserRoleSlug);
}
