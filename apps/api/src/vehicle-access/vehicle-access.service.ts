import { Injectable } from '@nestjs/common';
import { UserRole, AccessType } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { resolveTenantScope } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/types/auth-user';

@Injectable()
export class VehicleAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retourne les IDs des véhicules accessibles pour un user,
   * ou 'ALL' si l'user a accès à tout (FLEET_ADMIN, SUPER_ADMIN, ou AccessType.ALL).
   *
   * V1.10 (Sprint 2 perf) — 2 optimisations :
   *
   *  1. Memoization request-scoped : la methode est appelee plusieurs fois par
   *     requete HTTP (a chaque controller.rb() / service qui filtre). On stocke
   *     le resultat sur l'objet AuthUser, qui vit le temps de la requete.
   *     Gain : passe de N queries (typiquement 3-5) a 1 query par requete.
   *
   *  2. Aplatissement de l'`include` profond `group.vehicles` en 2 queries
   *     plates avec select minimal. L'include nested chargeait tous les
   *     vehicleGroupAssignment de chaque groupe meme si on ne voulait que
   *     le vehicleId. A 10+ groupes × 100+ vehicules, gain payload net.
   */
  async getAccessibleVehicleIds(user: AuthUser): Promise<string[] | 'ALL'> {
    // FLEET_ADMIN et SUPER_ADMIN voient tout
    if (user.role === UserRole.FLEET_ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return 'ALL';
    }

    // Cache memoization (request-scoped via l'objet user).
    const cached = (user as AuthUser & { __accessibleVehicleIds?: string[] | 'ALL' }).__accessibleVehicleIds;
    if (cached !== undefined) return cached;

    const rules = await this.prisma.userVehicleAccess.findMany({
      where: { userId: user.id },
      select: { accessType: true, groupId: true, vehicleId: true },
    });

    let result: string[] | 'ALL';
    if (rules.length === 0) {
      result = [];
    } else if (rules.some((r) => r.accessType === AccessType.ALL)) {
      result = 'ALL';
    } else {
      const vehicleIds = new Set<string>();
      const groupIds: string[] = [];

      for (const rule of rules) {
        if (rule.accessType === AccessType.VEHICLE && rule.vehicleId) {
          vehicleIds.add(rule.vehicleId);
        } else if (rule.accessType === AccessType.GROUP && rule.groupId) {
          groupIds.push(rule.groupId);
        }
      }

      if (groupIds.length > 0) {
        const assignments = await this.prisma.vehicleGroupAssignment.findMany({
          where: { groupId: { in: groupIds } },
          select: { vehicleId: true },
        });
        for (const a of assignments) vehicleIds.add(a.vehicleId);
      }

      result = [...vehicleIds];
    }

    (user as AuthUser & { __accessibleVehicleIds?: string[] | 'ALL' }).__accessibleVehicleIds = result;
    return result;
  }

  /**
   * Construit une clause Prisma WHERE pour filtrer les véhicules accessibles.
   * À utiliser dans les services qui query des véhicules.
   */
  async buildVehicleFilter(user: AuthUser): Promise<Prisma.VehicleWhereInput> {
    const ids = await this.getAccessibleVehicleIds(user);

    if (ids === 'ALL') {
      // V1.16 (audit residual) — fail-closed : un FLEET_ADMIN sans fleetId ne
      // doit matcher AUCUN vehicule (jamais "toutes flottes"). Cette methode n'a
      // aujourd'hui aucun appelant en prod, mais on corrige le pattern a la racine.
      const scope = resolveTenantScope(user);
      if (scope.mode === 'ALL') return {};
      if (scope.mode === 'FLEET') return { fleetId: scope.fleetId };
      return { id: { in: [] } };
    }

    return { id: { in: ids } };
  }

  /**
   * Vérifie si un user a accès à un véhicule spécifique.
   */
  async hasAccessToVehicle(user: AuthUser, vehicleId: string): Promise<boolean> {
    const ids = await this.getAccessibleVehicleIds(user);
    if (ids !== 'ALL') return ids.includes(vehicleId);

    // ⚠️ `'ALL'` NE VEUT PAS DIRE « TOUS LES VEHICULES DE LA BASE ».
    //
    // Pour un FLEET_ADMIN il signifie « aucune restriction PAR VEHICULE » — sous-entendu
    // dans sa flotte. Renvoyer `true` sans regarder la flotte transformait ce sentinel en
    // porte ouverte : avec un simple UUID d'une autre societe, un FLEET_ADMIN lisait le
    // detail d'un vehicule ou d'un trajet qui ne lui appartient pas (IDOR).
    //
    // Et ces UUID n'etaient pas difficiles a obtenir : la carte des stations-service les
    // livrait en clair (fuite corrigee le meme jour dans `fuel-report.service.ts`).
    const scope = resolveTenantScope(user);
    if (scope.mode === 'ALL') return true; // SUPER_ADMIN : perimetre reellement illimite
    if (scope.mode === 'DENY') return false; // ni super-admin, ni flotte -> rien

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { fleetId: true },
    });
    // Vehicule inexistant : on refuse. Repondre `true` laisserait l'appelant produire un
    // 404 ou un 500 selon les cas — un refus franc est plus lisible et plus sur.
    return vehicle?.fleetId === scope.fleetId;
  }
}
