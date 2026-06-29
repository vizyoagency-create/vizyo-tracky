import type { InstallationEnergy } from './installation.dto';

export type VehicleState = 'moving' | 'idle' | 'stopped' | 'engine_cut' | 'offline';

export interface VehicleDto {
  id: string;
  fleetId: string;
  plate: string;
  brand: string | null;
  model: string | null;
  state: VehicleState;
  trackerId: string | null;
  lastPosition: {
    lat: number;
    lng: number;
    speedKmh: number;
    timestamp: string;
  } | null;
}

/* ===================== Sprint 10 — Synchro véhicule ↔ planning d'installation ===================== */

/** Champs du véhicule synchronisables depuis la tâche d'installation liée. */
export type VehicleSyncableField = 'brand' | 'model' | 'energy';

/**
 * Données issues de la dernière tâche d'installation liée au véhicule = la SOURCE de synchro.
 * Le planning porte marque/modèle/énergie (saisis à la prépa de la pose) ; le véhicule, lui,
 * a souvent ces champs vides → on les recopie (auto à la pose + synchro manuelle).
 */
export interface VehicleInstallationSourceDto {
  taskId: string;
  planId: string;
  /** Nom du client du plan (repère lisible). */
  planName: string | null;
  /** Date planifiée de pose (ISO), si renseignée. */
  scheduledDate: string | null;
  brand: string | null;
  model: string | null;
  energy: InstallationEnergy | null;
  firstRegistrationDate: string | null;
}

/** Une ligne du tableau « Parc & capacités » : capacité du véhicule alignée sur la source planning. */
export interface VehicleCapacityRowDto {
  vehicleId: string;
  plate: string;
  type: string;
  brand: string | null;
  model: string | null;
  energy: InstallationEnergy | null;
  seats: number | null;
  childSeats: number | null;
  features: string[];
  group: { id: string; name: string } | null;
  /** Tâche d'installation liée (la plus récente), si elle existe. */
  installationSource: VehicleInstallationSourceDto | null;
  /** Champs où le planning a une valeur NON vide ≠ de celle du véhicule (proposables à la synchro). */
  divergentFields: VehicleSyncableField[];
}

/** Corps de la synchro manuelle : champs à recopier du planning vers le véhicule (écrasement assumé). */
export interface SyncVehicleFromInstallationDto {
  fields: VehicleSyncableField[];
}
