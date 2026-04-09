export interface VehicleResponse {
  id: string;
  fleetId: string;
  plate: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  tracker: { id: string; imei: string; status: string } | null;
  createdAt: Date;
  updatedAt: Date;
}
