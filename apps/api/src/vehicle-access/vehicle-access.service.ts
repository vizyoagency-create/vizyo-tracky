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
   */
  async getAccessibleVehicleIds(user: AuthUser): Promise<string[] | 'ALL'> {
    // FLEET_ADMIN et SUPER_ADMIN voient tout
    if (user.role === UserRole.FLEET_ADMIN || user.role === UserRole.SUPER_ADMIN) {
      return 'ALL';
    }

    const accessRules = await this.prisma.userVehicleAccess.findMany({
      where: { userId: user.id },
      include: {
        group: {
          include: {
            vehicles: { select: { vehicleId: true } },
          },
        },
      },
    });

    // Si aucun accès configuré → rien
    if (accessRules.length === 0) return [];

    // Si au moins un accès ALL → tout
    if (accessRules.some((r) => r.accessType === AccessType.ALL)) return 'ALL';

    const vehicleIds = new Set<string>();

    for (const rule of accessRules) {
      if (rule.accessType === AccessType.VEHICLE && rule.vehicleId) {
        vehicleIds.add(rule.vehicleId);
      }
      if (rule.accessType === AccessType.GROUP && rule.group) {
        for (const va of rule.group.vehicles) {
          vehicleIds.add(va.vehicleId);
        }
      }
    }

    return [...vehicleIds];
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
