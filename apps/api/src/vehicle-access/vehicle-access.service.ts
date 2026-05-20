import { Injectable } from '@nestjs/common';
import { UserRole, AccessType } from '@prisma/client';
import type { Prisma } from '@prisma/client';
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
      // Filtre par fleet uniquement (existant)
      if (user.role === UserRole.SUPER_ADMIN) return {};
      return { fleetId: user.fleetId ?? undefined };
    }

    return { id: { in: ids } };
  }

  /**
   * Vérifie si un user a accès à un véhicule spécifique.
   */
  async hasAccessToVehicle(user: AuthUser, vehicleId: string): Promise<boolean> {
    const ids = await this.getAccessibleVehicleIds(user);
    if (ids === 'ALL') return true;
    return ids.includes(vehicleId);
  }
}
