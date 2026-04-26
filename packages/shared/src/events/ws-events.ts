import type { PositionUpdateDto } from '../dto/position.dto';
import type { TrackerStatusChangedDto } from '../dto/tracker.dto';

export const WS_EVENTS = {
  POSITION_UPDATE: 'position:update',
  TRACKER_STATUS: 'tracker:status',
  ALERT_NEW: 'alert:new',
  ALERT_ACK: 'alert:acknowledged',
  GEOFENCE_VIOLATION: 'geofence:violation',
  TRIP_STARTED: 'trip:started',
  TRIP_COMPLETED: 'trip:completed',
  ENGINE_COMMAND_UPDATED: 'engine-command:updated',
} as const;

export interface PositionUpdateEvent {
  trackerId: string;
  vehicleId: string;
  fleetId: string;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number;
  timestamp: string;
  ignition: boolean;
  valid: boolean;
}

export interface AlertEvent {
  id: string;
  fleetId: string;
  vehicleId: string | null;
  trackerId: string | null;
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: string;
  vehiclePlate?: string;
}

export interface AlertAcknowledgedEvent {
  id: string;
  acknowledgedAt: string;
  acknowledgedBy: string;
}

export interface EngineCommandUpdatedEvent {
  commandId: string;
  trackerId: string;
  action: 'CUT' | 'RESTORE';
  status: 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'FAILED' | 'REJECTED_SPEED';
  lastError: string | null;
}

export interface ServerToClientEvents {
  'position:update': (payload: PositionUpdateEvent) => void;
  'tracker:status': (payload: TrackerStatusChangedDto) => void;
  'alert:new': (payload: AlertEvent) => void;
  'alert:acknowledged': (payload: AlertAcknowledgedEvent) => void;
  'engine-command:updated': (payload: EngineCommandUpdatedEvent) => void;
}

export interface ClientToServerEvents {
  'fleet:subscribe': (fleetId: string) => void;
  'fleet:unsubscribe': (fleetId: string) => void;
}
