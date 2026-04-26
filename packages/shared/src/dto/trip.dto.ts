export interface TripDto {
  id: string;
  vehicleId: string;
  trackerId: string | null;
  fleetId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  distanceMeters: number;
  maxSpeed: number;
  avgSpeed: number;
  startLat: number;
  startLng: number;
  endLat: number | null;
  endLng: number | null;
  positionCount: number;
  segmentationSource: string;
  polyline: string | null;
  /** Sprint G.3 V1.4 : polyligne snappee aux routes via OSRM. Optionnelle. */
  polylineMatched?: string | null;
}

export interface TripDailySummaryDto {
  date: string;
  tripCount: number;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  maxSpeed: number;
}

export interface TripRecomputeResultDto {
  deleted: number;
  created: number;
}

export interface TripStartedEvent {
  tripId: string;
  vehicleId: string;
  trackerId: string;
  fleetId: string;
  startedAt: string;
  startLat: number;
  startLng: number;
}

export interface TripCompletedEvent {
  tripId: string;
  vehicleId: string;
  trackerId: string;
  fleetId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  distanceMeters: number;
  maxSpeed: number;
  avgSpeed: number;
}
