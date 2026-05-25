import { SetMetadata } from '@nestjs/common';
import type { UserPermissions } from '@vizyo/tracky-shared';

/**
 * V1.11 Phase 1 — Decorator pour exiger une permission resolue per-vehicle.
 *
 * Different de @RequirePermissions qui resout globalement (union des scopes du
 * user). @RequireVehiclePermission resout selon la ligne UserVehicleAccess qui
 * couvre ce vehicleId precis (regle "specifique gagne" VEHICLE > GROUP > ALL).
 *
 * Le guard extrait le vehicleId depuis req.params[paramName] (defaut 'vehicleId'),
 * fallback req.body[paramName] puis req.query[paramName]. Si `paramName === 'trackerId'`,
 * la guard resout d'abord trackerId → vehicleId via 1 query Prisma.
 *
 * Exemple — coupure moteur :
 *   @Post('trackers/:trackerId/commands')
 *   @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
 *   @RequireVehiclePermission('engine_control', { paramName: 'trackerId' })
 *   requestCommand(...) { ... }
 *
 * Admins (SUPER_ADMIN, FLEET_ADMIN) bypass — meme semantique que @RequirePermissions.
 */
export const VEHICLE_PERMISSIONS_KEY = 'required-vehicle-permissions';

export interface VehiclePermissionsSpec {
  keys: Array<keyof UserPermissions>;
  /** Nom du parametre de route qui porte l'ID du vehicule (ou tracker). Defaut: `vehicleId`. */
  paramName: string;
}

export const RequireVehiclePermission = (
  key: keyof UserPermissions,
  options?: { paramName?: string },
) =>
  SetMetadata<string, VehiclePermissionsSpec>(VEHICLE_PERMISSIONS_KEY, {
    keys: [key],
    paramName: options?.paramName ?? 'vehicleId',
  });
