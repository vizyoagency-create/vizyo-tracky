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
  clampPartialPermissions as sharedClampPartialPermissions,
  clampPermissions as sharedClampPermissions,
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

/**
 * Clamp cote API (accepte un `UserRole` Prisma + des permissions JSON brutes).
 * Borne `requested` aux permissions effectives du granter — cf. la fonction
 * partagee `clampPermissions`. Empeche l'escalade de privileges (un inviteur ne
 * peut accorder une capacite qu'il ne possede pas lui-meme).
 */
export function clampPermissions(
  requested: Partial<UserPermissions> | null | undefined,
  granter: { role: UserRole; permissions?: unknown },
  fallback: UserPermissions,
): UserPermissions {
  return sharedClampPermissions(
    requested,
    {
      role: granter.role as UserRoleSlug,
      permissions: (granter.permissions ?? null) as Partial<UserPermissions> | null,
    },
    fallback,
  );
}

/**
 * Clamp partiel cote API (overrides par scope UserVehicleAccess). Ne materialise
 * que les cles fournies, chacune bornee au granter. Cf. clampPartialPermissions.
 */
export function clampPartialPermissions(
  requested: Partial<UserPermissions>,
  granter: { role: UserRole; permissions?: unknown },
): Partial<UserPermissions> {
  return sharedClampPartialPermissions(requested, {
    role: granter.role as UserRoleSlug,
    permissions: (granter.permissions ?? null) as Partial<UserPermissions> | null,
  });
}
