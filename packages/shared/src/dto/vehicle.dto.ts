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
