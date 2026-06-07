/**
 * Phase 2 — DTOs Conducteur partages frontend/backend.
 *
 * `DriverDto` est la representation complete (utilisee dans la page liste +
 * drawer edition). `DriverSummaryDto` est l'allegee — utilisee pour les pills,
 * snapshots dans Trip/Vehicle, et selecteurs.
 */

export interface DriverSummaryDto {
  id: string;
  firstName: string;
  lastName: string;
  /** Couleur hex de pastille UI (default vert tracky cote backend). */
  color: string | null;
  isActive: boolean;
}

export interface DriverDto extends DriverSummaryDto {
  fleetId: string;
  phone: string | null;
  email: string | null;
  licenseNumber: string | null;
  notes: string | null;
  /** Phase 3 — User lie pour login driver. null = compte tag sans login. */
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * V1.15 — Compteurs contextuels (badges UI). Optionnels pour backward compat :
   *   - _count.currentVehicles : nombre de vehicules dont ce driver est le
   *     conducteur actuel (Vehicle.currentDriverId).
   *   - _count.trips : nombre total de trajets historiques de ce driver.
   * Renvoyes par GET /drivers ; absents sur les endpoints qui retournent un
   * driver sans agregation (ex: GET /drivers/:id n'inclut pas _count).
   */
  _count?: {
    currentVehicles?: number;
    trips?: number;
  };
}

export interface CreateDriverDto {
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  licenseNumber?: string | null;
  color?: string | null;
  notes?: string | null;
}

export interface UpdateDriverDto {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  email?: string | null;
  licenseNumber?: string | null;
  color?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export interface AssignDriverDto {
  /** null = retirer l'assignation. */
  driverId: string | null;
}
