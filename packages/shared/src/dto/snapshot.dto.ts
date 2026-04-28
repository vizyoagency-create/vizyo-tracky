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

  /**
   * V1.7 — Indique si le fil ACC du tracker est connecte. Si false, l'app
   * frontend sait que `lastIgnition` peut etre inferee depuis la vitesse
   * (mode degrade, fiabilite reduite a l'arret). Default null si pas de tracker.
   */
  accConnected: boolean | null;

  /**
   * V1.7 — true si une commande CUT (SENT/ACKNOWLEDGED) est active sur ce tracker
   * sans RESTORE posterieure. Permet au popup carte d'afficher le bon bouton
   * des le chargement, sans attendre un event WS.
   */
  engineCutActive: boolean | null;

  /** V1.7 — true si un schedule horaire est actif sur ce véhicule. */
  scheduleEnabled: boolean;
}

export interface FleetSnapshotResponse {
  items: VehicleSnapshotDto[];
}
