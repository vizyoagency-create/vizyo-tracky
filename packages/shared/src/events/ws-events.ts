import type { PositionUpdateDto } from '../dto/position.dto';
import type { TrackerStatusChangedDto } from '../dto/tracker.dto';

export const WS_EVENTS = {
  POSITION_UPDATE: 'position:update',
  // V1.5 (Sprint H1) — batch coalescing : flush 1s d'updates en un seul event.
  // Le client doit traiter chaque entree comme un POSITION_UPDATE individuel.
  POSITIONS_BATCH: 'positions:batch',
  TRACKER_STATUS: 'tracker:status',
  ALERT_NEW: 'alert:new',
  ALERT_ACK: 'alert:acknowledged',
  GEOFENCE_VIOLATION: 'geofence:violation',
  TRIP_STARTED: 'trip:started',
  TRIP_COMPLETED: 'trip:completed',
  ENGINE_COMMAND_UPDATED: 'engine-command:updated',
} as const;

export interface PositionsBatchEvent {
  fleetId: string;
  positions: PositionUpdateEvent[];
}

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
  /** Speed at the time of the alert (km/h), when available (e.g. OVERSPEED). */
  speedKmh?: number;
  /**
   * Présent sur les réponses REST (liste d'alertes) : véhicule lié + son groupe,
   * pour afficher le badge groupe sans requête supplémentaire. Absent de l'event WS.
   */
  vehicle?: { id: string; plate: string; group?: { id: string; name: string } | null } | null;
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
  /** Sprint 2 — true si une chute d'ignition est attendable comme preuve (CUT en marche). */
  confirmationExpected?: boolean;
  /** Sprint 2 — horodatages pour dériver l'état d'attente/confirmation côté UI. */
  sentAt?: string | null;
  ackedAt?: string | null;
  /** Sprint 2 — origine, pour distinguer une détection device d'une commande app. */
  source?: 'MANUAL' | 'SCHEDULER' | 'DEVICE_OBSERVED';
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
