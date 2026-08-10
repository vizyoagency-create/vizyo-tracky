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
  // Fix veilleur — état « en mouvement » minimal (booléen, aucune position) émis vers
  // `ops:fleet:*`. Le veilleur de nuit ne reçoit AUCUNE position ; ce flag lui permet de
  // griser le bouton « Couper » sur un véhicule en marche (le serveur reste seul juge).
  VEHICLE_MOVEMENT: 'vehicle:movement',
  // Espace dépôt (2026-08) — la position d'un camion sur UNE mission, émise vers le
  // salon `depot:mission:<id>` et vers lui seul. Payload volontairement distinct de
  // `POSITION_UPDATE` : il ne porte ni trackerId, ni vehicleId, ni fleetId. Réutiliser
  // l'event de flotte aurait servi ces trois identifiants à un tiers (A3 § 7, règle 3).
  DEPOT_MISSION_POSITION: 'depot:mission:position',
  // La mission s'est terminée pendant la consultation : le marqueur doit disparaître
  // AVEC une explication, sinon le dépôt croit avoir perdu le camion (A3 § 6).
  DEPOT_MISSION_ENDED: 'depot:mission:ended',
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

/**
 * Espace dépôt (2026-08) — ce qu'un dépôt reçoit en direct, et rien de plus.
 *
 * ⚠️ CONTRAT DE FUITE, au même titre que `DepotMissionDto`. Comparez-le à
 * `PositionUpdateEvent` : `trackerId`, `vehicleId` et `fleetId` en sont ABSENTS.
 * La mission est la seule clé — c'est par elle que le dépôt a le droit de voir ce
 * point, et elle suffit à le rattacher à un marqueur sur sa carte.
 */
export interface DepotMissionPositionEvent {
  missionId: string;
  lat: number;
  lng: number;
  speedKmh: number;
  /** ISO 8601 — l'heure de la POSITION, pas celle de l'émission. */
  timestamp: string;
}

/** La mission s'est terminée : le suivi s'arrête ici. */
export interface DepotMissionEndedEvent {
  missionId: string;
  missionRef: string;
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

/**
 * Fix veilleur — transition d'état « en mouvement » d'un véhicule. Émis UNIQUEMENT
 * au changement (roule ↔ à l'arrêt) → volume faible. Ne porte AUCUNE donnée de
 * position (ni lat/lng, ni vitesse exacte) : juste le booléen dont le veilleur a
 * besoin pour savoir si la coupe est permise.
 */
export interface VehicleMovementEvent {
  trackerId: string;
  fleetId: string;
  moving: boolean;
}

export interface ServerToClientEvents {
  'position:update': (payload: PositionUpdateEvent) => void;
  'tracker:status': (payload: TrackerStatusChangedDto) => void;
  'alert:new': (payload: AlertEvent) => void;
  'alert:acknowledged': (payload: AlertAcknowledgedEvent) => void;
  'engine-command:updated': (payload: EngineCommandUpdatedEvent) => void;
  'vehicle:movement': (payload: VehicleMovementEvent) => void;
}

export interface ClientToServerEvents {
  'fleet:subscribe': (fleetId: string) => void;
  'fleet:unsubscribe': (fleetId: string) => void;
}
