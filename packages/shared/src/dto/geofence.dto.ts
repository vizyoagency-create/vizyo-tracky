export interface GeofenceDto {
  id: string;
  fleetId: string;
  name: string;
  type: 'CIRCLE' | 'POLYGON';
  rule: 'ENTER' | 'EXIT' | 'BOTH';
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
  /** Sprint F.2 V1.4 : sommets du polygone si type = POLYGON. */
  polygonPoints?: Array<{ lat: number; lng: number }> | null;
  color: string | null;
  active: boolean;
  createdAt: string;
  /**
   * V1.15 — Compteur contextuel pour les cards :
   * nombre de véhicules ciblés (relation GeofenceVehicle).
   * Renvoyé par GET /geofences (liste). Absent sur GET /geofences/:id.
   */
  _count?: {
    vehicleTargets?: number;
  };
}

export interface GeofenceViolationEvent {
  geofenceId: string;
  geofenceName: string;
  trackerId: string;
  vehicleId: string | null;
  fleetId: string;
  violation: 'ENTER' | 'EXIT';
  lat: number;
  lng: number;
  at: string;
}
