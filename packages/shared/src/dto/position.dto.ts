export interface PositionDto {
  id: string;
  trackerId: string;
  vehicleId: string | null;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number;
  altitude: number | null;
  satellites: number | null;
  timestamp: string;
}

export interface PositionUpdateDto {
  trackerId: string;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number;
  timestamp: string;
}
