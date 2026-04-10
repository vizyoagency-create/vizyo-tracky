export interface GeofenceDto {
  id: string;
  fleetId: string;
  name: string;
  type: 'CIRCLE' | 'POLYGON';
  rule: 'ENTER' | 'EXIT' | 'BOTH';
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
  color: string | null;
  active: boolean;
  createdAt: string;
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
