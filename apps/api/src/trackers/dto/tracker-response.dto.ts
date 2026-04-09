export interface TrackerResponse {
  id: string;
  imei: string;
  model: string;
  status: string;
  lastSeenAt: Date | null;
  vehicleId: string | null;
  vehicle: { id: string; plate: string; fleetId: string } | null;
  createdAt: Date;
  updatedAt: Date;
}
