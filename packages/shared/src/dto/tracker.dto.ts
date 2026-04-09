export type TrackerStatus = 'online' | 'offline' | 'idle';

export interface TrackerDto {
  id: string;
  imei: string;
  model: string;
  status: TrackerStatus;
  lastSeenAt: string | null;
  vehicleId: string | null;
}

export interface TrackerStatusChangedDto {
  trackerId: string;
  imei: string;
  status: TrackerStatus;
  at: string;
}
