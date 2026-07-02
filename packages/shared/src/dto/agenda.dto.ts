/**
 * Sprint 7 — Agenda générique (maintenance + incidents ; fondation Sprint 8 réservations).
 * Types partagés API ↔ web. Le modèle `VehicleEvent` est volontairement générique : `type`
 * (enum extensible), `category` (string libre), `startAt`/`endAt`/`allDay` (ponctuel/plage/
 * créneau) et `metadata` (champs par type sans migration) accueilleront les réservations S8.
 */

export type VehicleEventType = 'MAINTENANCE' | 'INCIDENT' | 'RESERVATION';
export type VehicleEventStatus =
  | 'PLANNED'
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'CANCELLED'
  | 'REQUESTED' // Sprint 8 — réservation en attente de validation (non bloquant)
  | 'CONFIRMED'; // Sprint 8 — réservation ferme (bloquante)
export type VehicleEventSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface VehicleEventDto {
  id: string;
  fleetId: string;
  vehicleId: string;
  vehiclePlate: string | null;
  type: VehicleEventType;
  category: string | null;
  status: VehicleEventStatus;
  severity: VehicleEventSeverity | null;
  title: string;
  description: string | null;
  /** ISO. Ancrage temporel (échéance / réalisation / début). */
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  /** Immobilise le véhicule : exclu des réservations/suggestions tant que l'événement est actif. */
  blocksVehicle: boolean;
  odometerKm: number | null;
  planId: string | null;
  linkedEventId: string | null;
  resolvedAt: string | null;
  metadata: Record<string, unknown> | null;
  /** MANUAL | AUTO | SYSTEM. */
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVehicleEventDto {
  vehicleId: string;
  /** MAINTENANCE | INCIDENT (RESERVATION réservé Sprint 8). */
  type: VehicleEventType;
  category?: string;
  status?: VehicleEventStatus;
  severity?: VehicleEventSeverity;
  title: string;
  description?: string;
  startAt: string;
  endAt?: string;
  allDay?: boolean;
  /** Immobilise le véhicule. Défaut serveur : true pour un INCIDENT, false sinon. */
  blocksVehicle?: boolean;
  odometerKm?: number;
  metadata?: Record<string, unknown>;
}

export interface ReportIncidentDto {
  vehicleId: string;
  title: string;
  severity?: VehicleEventSeverity;
  description?: string;
  /** Immobilise le véhicule (défaut : true — un incident signalé rend indisponible). */
  blocksVehicle?: boolean;
}

export interface UpdateVehicleEventDto {
  status?: VehicleEventStatus;
  category?: string;
  severity?: VehicleEventSeverity;
  title?: string;
  description?: string;
  startAt?: string;
  endAt?: string | null;
  allDay?: boolean;
  blocksVehicle?: boolean;
  odometerKm?: number;
  linkedEventId?: string;
  metadata?: Record<string, unknown>;
}

export interface MaintenancePlanDto {
  id: string;
  fleetId: string;
  vehicleId: string;
  category: string;
  label: string;
  intervalMonths: number | null;
  intervalKm: number | null;
  lastDoneAt: string | null;
  lastDoneKm: number | null;
  reminderDaysBefore: number;
  reminderKmBefore: number | null;
  enabled: boolean;
  /** Calculés : prochaine échéance (date / km) à partir du dernier réalisé + l'intervalle. */
  nextDueAt: string | null;
  nextDueKm: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertMaintenancePlanDto {
  vehicleId: string;
  category: string;
  label: string;
  intervalMonths?: number;
  intervalKm?: number;
  lastDoneAt?: string;
  lastDoneKm?: number;
  reminderDaysBefore?: number;
  reminderKmBefore?: number;
  enabled?: boolean;
}

export interface RecordMaintenanceDoneDto {
  doneAt?: string;
  doneKm?: number;
  note?: string;
}

export interface OdometerEstimateDto {
  vehicleId: string;
  /** Dernier relevé manuel (autoritaire). */
  lastOdometerKm: number | null;
  lastOdometerAt: string | null;
  /** Distance GPS cumulée depuis le dernier relevé (SUM trajets). */
  gpsDistanceSinceKm: number;
  /** Estimation = baseline manuel + GPS depuis (indicative, ±3-5%). */
  estimatedKm: number | null;
}

export interface AgendaSummaryDto {
  /** PLANNED/OPEN dont l'échéance est passée (en retard). */
  overdue: number;
  /** PLANNED dans les 30 prochains jours. */
  upcoming: number;
  /** Incidents OPEN/IN_PROGRESS. */
  openIncidents: number;
}

/** Statuts d'un événement (incident/maintenance) encore ACTIF → immobilisant si `blocksVehicle`. */
export const IMMOBILIZING_STATUSES: VehicleEventStatus[] = ['PLANNED', 'OPEN', 'IN_PROGRESS'];

/** L'événement immobilise-t-il ENCORE le véhicule (bloquant + non clôturé) ? */
export function isImmobilizingEvent(
  ev: Pick<VehicleEventDto, 'type' | 'status' | 'blocksVehicle'>,
): boolean {
  return (
    ev.blocksVehicle && ev.type !== 'RESERVATION' && IMMOBILIZING_STATUSES.includes(ev.status)
  );
}

/**
 * Fin EFFECTIVE d'immobilisation d'un événement bloquant (ms epoch). SOURCE UNIQUE partagée
 * API ↔ web : la disponibilité affichée DOIT correspondre exactement à ce que la réservation
 * accepte, sinon l'UI montre « libre » là où le serveur renvoie un 409. Règle : `endAt` si présent ;
 * sinon un INCIDENT bloque jusqu'à résolution (∞), une MAINTENANCE ~24 h (sa journée).
 */
export function effectiveBlockingEndMs(
  type: VehicleEventType,
  startAtMs: number,
  endAtMs: number | null,
): number {
  if (endAtMs != null) return endAtMs;
  if (type === 'INCIDENT') return Number.POSITIVE_INFINITY;
  return startAtMs + 24 * 60 * 60 * 1000;
}
