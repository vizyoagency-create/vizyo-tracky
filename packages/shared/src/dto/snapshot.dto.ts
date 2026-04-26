/**
 * Snapshot d'un vehicule : metadonnees + derniere position connue (denormalisee).
 * Utilise pour l'hydratation immediate de la carte au login (chantier 1 — V1.4).
 *
 * Source : `Tracker.last*` (mis a jour a chaque ingest dans `PositionsService.ingest`).
 */
export interface VehicleSnapshotDto {
  vehicleId: string;
  fleetId: string;
  plate: string;
  type: string;
  brand: string | null;
  model: string | null;

  trackerId: string | null;
  trackerImei: string | null;
  trackerStatus: 'ONLINE' | 'OFFLINE' | 'IDLE' | null;
  lastSeenAt: string | null;

  lastLat: number | null;
  lastLng: number | null;
  lastSpeedKmh: number | null;
  lastHeading: number | null;
  lastIgnition: boolean | null;
  lastValid: boolean | null;
  lastPositionAt: string | null;
}

export interface FleetSnapshotResponse {
  items: VehicleSnapshotDto[];
}
