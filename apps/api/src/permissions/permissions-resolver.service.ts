import { Injectable } from '@nestjs/common';
import { AccessType, UserRole } from '@prisma/client';
import {
  getDefaultPermissions,
  PERMISSION_KEYS,
  type UserPermissions,
  type UserRoleSlug,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';

/**
 * V1.11 Phase 1 — Resolveur de permissions per-scope.
 *
 * Le user porte des permissions JSON globales (`User.permissions`) ET des
 * overrides par scope (`UserVehicleAccess.permissions`). Selon l'action :
 *
 * - **Actions per-vehicle** (couper moteur, modifier ce vehicule precis) :
 *   on resout VEHICLE > GROUP > ALL → "specifique gagne". Si `engine_control=true`
 *   sur ALL et `=false` sur ce véhicule, le véhicule l'emporte → refus.
 *
 * - **Actions globales** (créer un véhicule, voir la liste des conducteurs,
 *   acceder a /reports) : on resout l'union de tous les scopes. Le user peut
 *   l'action s'il peut sur AU MOINS un scope (sinon on cacherait un bouton
 *   "Créer" alors qu'il pourrait créer dans un de ses groupes).
 *
 * Fallback : si une ligne d'accès a `permissions IS NULL` (legacy / oubli UI),
 * on tombe sur `User.permissions`. Si toujours null, sur `getDefaultPermissions(role)`.
 *
 * Memoization request-scoped sur l'objet `user` (1 query par requete HTTP).
 * Admins (SUPER_ADMIN, FLEET_ADMIN) shortcircuitent : tous booleens true.
 */
const ADMIN_ROLES: UserRole[] = [UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN];

/** Tri des lignes d'accès : la plus specifique gagne en cas de conflit. */
const ACCESS_TYPE_PRIORITY: Record<AccessType, number> = {
  VEHICLE: 3,
  GROUP: 2,
  ALL: 1,
};

type UserWithCache = AuthUser & {
  __resolvedPerVehicle?: Map<string, UserPermissions | null>;
  __resolvedGlobal?: UserPermissions;
};

@Injectable()
export class PermissionsResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resout les permissions du user pour un vehicule precis. Regle "specifique
   * gagne" : VEHICLE > GROUP > ALL. Retourne `null` si aucune ligne d'accès ne
   * couvre ce vehicleId (= le user n'y a pas accès du tout — different de
   * "accès mais permissions a false").
   */
  async resolveForVehicle(user: AuthUser, vehicleId: string): Promise<UserPermissions | null> {
    if (this.isAdmin(user)) return getDefaultPermissions(user.role as UserRoleSlug);

    const cache = (user as UserWithCache).__resolvedPerVehicle;
    const cached = cache?.get(vehicleId);
    if (cached !== undefined) return cached;

    const access = await this.prisma.userVehicleAccess.findMany({
      where: {
        userId: user.id,
        OR: [
          { accessType: AccessType.ALL },
          { accessType: AccessType.VEHICLE, vehicleId },
          { accessType: AccessType.GROUP, group: { vehicles: { some: { vehicleId } } } },
        ],
      },
      select: { accessType: true, permissions: true },
    });

    if (access.length === 0) {
      this.cachePerVehicle(user, vehicleId, null);
      return null;
    }

    access.sort((a, b) => ACCESS_TYPE_PRIORITY[b.accessType] - ACCESS_TYPE_PRIORITY[a.accessType]);
    const winning = access[0];

    const resolved = this.applyFallbacks(this.asPermsObject(winning.permissions), user);
    this.cachePerVehicle(user, vehicleId, resolved);
    return resolved;
  }

  /**
   * Resout les permissions globales du user (union des permissions resolues sur
   * chaque scope). Utilise par `@RequirePermissions(...)` cote backend et par
   * `PermissionsService.can(perm)` cote frontend sans vehicleId.
   *
   * Si le user n'a aucune ligne d'acces, fallback `User.permissions` puis defaults.
   */
  async resolveGlobal(user: AuthUser): Promise<UserPermissions> {
    if (this.isAdmin(user)) return getDefaultPermissions(user.role as UserRoleSlug);

    const cachedGlobal = (user as UserWithCache).__resolvedGlobal;
    if (cachedGlobal) return cachedGlobal;

    const access = await this.prisma.userVehicleAccess.findMany({
      where: { userId: user.id },
      select: { permissions: true },
    });

    let resolved: UserPermissions;
    if (access.length === 0) {
      resolved = this.applyFallbacks(null, user);
    } else {
      const perScopeResolved = access.map((a) =>
        this.applyFallbacks(this.asPermsObject(a.permissions), user),
      );
      resolved = this.unionResolvedScopes(perScopeResolved);
    }

    (user as UserWithCache).__resolvedGlobal = resolved;
    return resolved;
  }

  async canOnVehicle(
    user: AuthUser,
    vehicleId: string,
    key: keyof UserPermissions,
  ): Promise<boolean> {
    if (this.isAdmin(user)) return true;
    const perms = await this.resolveForVehicle(user, vehicleId);
    if (!perms) return false;
    return perms[key] === true;
  }

  async canGlobally(user: AuthUser, key: keyof UserPermissions): Promise<boolean> {
    if (this.isAdmin(user)) return true;
    const perms = await this.resolveGlobal(user);
    return perms[key] === true;
  }

  /**
   * Batch : resout les permissions pour plusieurs vehicules en 1 query.
   * Utile sur les listings (ex: page vehicules, decider quel bouton afficher
   * sur chaque ligne sans faire N queries). Hydrate le cache request-scoped.
   */
  async resolveForVehicles(
    user: AuthUser,
    vehicleIds: string[],
  ): Promise<Map<string, UserPermissions | null>> {
    if (this.isAdmin(user)) {
      const adminPerms = getDefaultPermissions(user.role as UserRoleSlug);
      return new Map(vehicleIds.map((vid) => [vid, adminPerms]));
    }
    if (vehicleIds.length === 0) return new Map();

    const access = await this.prisma.userVehicleAccess.findMany({
      where: {
        userId: user.id,
        OR: [
          { accessType: AccessType.ALL },
          { accessType: AccessType.VEHICLE, vehicleId: { in: vehicleIds } },
          {
            accessType: AccessType.GROUP,
            group: { vehicles: { some: { vehicleId: { in: vehicleIds } } } },
          },
        ],
      },
      select: {
        accessType: true,
        permissions: true,
        vehicleId: true,
        group: { select: { vehicles: { select: { vehicleId: true } } } },
      },
    });

    const result = new Map<string, UserPermissions | null>();
    for (const vid of vehicleIds) {
      const matching = access.filter((a) => {
        if (a.accessType === AccessType.ALL) return true;
        if (a.accessType === AccessType.VEHICLE) return a.vehicleId === vid;
        if (a.accessType === AccessType.GROUP) {
          return a.group?.vehicles.some((v) => v.vehicleId === vid) ?? false;
        }
        return false;
      });

      if (matching.length === 0) {
        result.set(vid, null);
        continue;
      }

      matching.sort(
        (a, b) => ACCESS_TYPE_PRIORITY[b.accessType] - ACCESS_TYPE_PRIORITY[a.accessType],
      );
      const winning = matching[0];
      result.set(vid, this.applyFallbacks(this.asPermsObject(winning.permissions), user));
    }

    const cache = ((user as UserWithCache).__resolvedPerVehicle ??= new Map());
    for (const [vid, perms] of result) cache.set(vid, perms);

    return result;
  }

  // === Internals ===

  private isAdmin(user: AuthUser): boolean {
    return ADMIN_ROLES.includes(user.role);
  }

  private cachePerVehicle(
    user: AuthUser,
    vehicleId: string,
    perms: UserPermissions | null,
  ): void {
    const cache = ((user as UserWithCache).__resolvedPerVehicle ??= new Map());
    cache.set(vehicleId, perms);
  }

  /**
   * Cast safe du JSON Prisma vers Partial<UserPermissions>. Le scope
   * `permissions` peut etre partiel (cles manquantes apres ajout d'une nouvelle
   * perm en cours de migration). Les cles manquantes seront comblees par
   * applyFallbacks.
   */
  private asPermsObject(json: unknown): Partial<UserPermissions> | null {
    if (json === null || typeof json !== 'object') return null;
    return json as Partial<UserPermissions>;
  }

  /**
   * Comble les permissions partielles du scope avec User.permissions, puis
   * avec les defaults du role en dernier ressort. Garantit un objet complet.
   */
  private applyFallbacks(
    scopePerms: Partial<UserPermissions> | null,
    user: AuthUser,
  ): UserPermissions {
    const roleDefaults = getDefaultPermissions(user.role as UserRoleSlug);
    const userPerms: UserPermissions = user.permissions
      ? { ...roleDefaults, ...user.permissions }
      : roleDefaults;

    if (!scopePerms) return userPerms;

    const merged: UserPermissions = { ...userPerms };
    for (const key of PERMISSION_KEYS) {
      if (scopePerms[key] !== undefined) {
        merged[key] = scopePerms[key] as boolean;
      }
    }
    return merged;
  }

  /**
   * Union des permissions deja resolues par scope : true si au moins un scope
   * l'autorise. Semantique "le user peut globalement faire X s'il peut le faire
   * dans AU MOINS un de ses scopes".
   */
  private unionResolvedScopes(scopes: UserPermissions[]): UserPermissions {
    const seed = scopes[0] ? { ...scopes[0] } : ({} as UserPermissions);
    for (let i = 1; i < scopes.length; i++) {
      for (const key of PERMISSION_KEYS) {
        if (scopes[i][key]) seed[key] = true;
      }
    }
    return seed;
  }
}
