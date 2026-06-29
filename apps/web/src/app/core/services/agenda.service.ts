import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AgendaSummaryDto,
  FleetOptimizationDto,
  ForecastResultDto,
  VehicleAvailabilityDto,
  RequestReservationDto,
  ConfirmReservationDto,
  UpdateReservationDto,
  SuggestReservationResultDto,
  CreateVehicleEventDto,
  MaintenancePlanDto,
  OdometerEstimateDto,
  RecordMaintenanceDoneDto,
  ReportIncidentDto,
  UpdateVehicleEventDto,
  UpsertMaintenancePlanDto,
  VehicleEventDto,
  VehicleEventStatus,
  VehicleEventType,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Sprint 7 — Agenda (maintenance + incidents). Client HTTP typé sur les DTOs
 * partagés (`@vizyo/tracky-shared`). Un wrapper par endpoint `/api/agenda/*`.
 * L'intercepteur d'auth pose les headers/credentials — rien à faire ici.
 */

/** Filtres optionnels de la liste d'événements. `from`/`to` en ISO. */
export interface AgendaEventQuery {
  from?: string;
  to?: string;
  vehicleId?: string;
  groupId?: string;
  type?: VehicleEventType;
  status?: VehicleEventStatus;
}

@Injectable({ providedIn: 'root' })
export class AgendaApiService {
  private readonly http = inject(HttpClient);

  /** GET /api/agenda/events — événements de la flotte sur une fenêtre temporelle. */
  listEvents(query: AgendaEventQuery): Observable<VehicleEventDto[]> {
    const params: Record<string, string> = {};
    if (query.from) params['from'] = query.from;
    if (query.to) params['to'] = query.to;
    if (query.vehicleId) params['vehicleId'] = query.vehicleId;
    if (query.groupId) params['groupId'] = query.groupId;
    if (query.type) params['type'] = query.type;
    if (query.status) params['status'] = query.status;
    return this.http.get<VehicleEventDto[]>('/api/agenda/events', { params });
  }

  /** GET /api/agenda/summary — compteurs (en retard / à venir / incidents ouverts). */
  summary(): Observable<AgendaSummaryDto> {
    return this.http.get<AgendaSummaryDto>('/api/agenda/summary');
  }

  /** GET /api/agenda/vehicles/:id/odometer — estimation kilométrique (relevé + GPS). */
  odometer(vehicleId: string): Observable<OdometerEstimateDto> {
    return this.http.get<OdometerEstimateDto>(`/api/agenda/vehicles/${vehicleId}/odometer`);
  }

  /** POST /api/agenda/incidents — signalement rapide d'incident (status OPEN). */
  reportIncident(data: ReportIncidentDto): Observable<VehicleEventDto> {
    return this.http.post<VehicleEventDto>('/api/agenda/incidents', data);
  }

  /** POST /api/agenda/events — création d'un événement (maintenance / incident). */
  createEvent(data: CreateVehicleEventDto): Observable<VehicleEventDto> {
    return this.http.post<VehicleEventDto>('/api/agenda/events', data);
  }

  /** PATCH /api/agenda/events/:id — modification partielle (statut, dates, ...). */
  updateEvent(id: string, data: UpdateVehicleEventDto): Observable<VehicleEventDto> {
    return this.http.patch<VehicleEventDto>(`/api/agenda/events/${id}`, data);
  }

  /** DELETE /api/agenda/events/:id — suppression d'un événement. */
  deleteEvent(id: string): Observable<void> {
    return this.http.delete<void>(`/api/agenda/events/${id}`);
  }

  /** GET /api/agenda/plans — plans d'entretien (optionnellement filtrés véhicule). */
  listPlans(vehicleId?: string): Observable<MaintenancePlanDto[]> {
    const params: Record<string, string> = {};
    if (vehicleId) params['vehicleId'] = vehicleId;
    return this.http.get<MaintenancePlanDto[]>('/api/agenda/plans', { params });
  }

  /** POST /api/agenda/plans — création d'un plan d'entretien récurrent. */
  createPlan(data: UpsertMaintenancePlanDto): Observable<MaintenancePlanDto> {
    return this.http.post<MaintenancePlanDto>('/api/agenda/plans', data);
  }

  /** PUT /api/agenda/plans/:id — mise à jour d'un plan d'entretien. */
  updatePlan(id: string, data: UpsertMaintenancePlanDto): Observable<MaintenancePlanDto> {
    return this.http.put<MaintenancePlanDto>(`/api/agenda/plans/${id}`, data);
  }

  /** POST /api/agenda/plans/:id/done — enregistre un entretien réalisé (recale les échéances). */
  recordPlanDone(id: string, data: RecordMaintenanceDoneDto): Observable<MaintenancePlanDto> {
    return this.http.post<MaintenancePlanDto>(`/api/agenda/plans/${id}/done`, data);
  }

  /** DELETE /api/agenda/plans/:id — suppression d'un plan d'entretien. */
  deletePlan(id: string): Observable<void> {
    return this.http.delete<void>(`/api/agenda/plans/${id}`);
  }

  // ─── Sprint 8 (Palier A) — Visibilité flotte (lecture seule, gardé reservations_view) ───

  /** GET /api/agenda/availability — activité réelle (trajets) sur une fenêtre, couche agenda. */
  getAvailability(query: {
    from: string;
    to: string;
    vehicleId?: string;
    groupId?: string;
  }): Observable<VehicleAvailabilityDto> {
    const params: Record<string, string> = { from: query.from, to: query.to };
    if (query.vehicleId) params['vehicleId'] = query.vehicleId;
    if (query.groupId) params['groupId'] = query.groupId;
    return this.http.get<VehicleAvailabilityDto>('/api/agenda/availability', { params });
  }

  /** GET /api/optimization/utilization — heatmap d'utilisation + sous-utilisation (dashboard). */
  getUtilization(query?: {
    from?: string;
    to?: string;
    vehicleId?: string;
    groupId?: string;
  }): Observable<FleetOptimizationDto> {
    const params: Record<string, string> = {};
    if (query?.from) params['from'] = query.from;
    if (query?.to) params['to'] = query.to;
    if (query?.vehicleId) params['vehicleId'] = query.vehicleId;
    if (query?.groupId) params['groupId'] = query.groupId;
    return this.http.get<FleetOptimizationDto>('/api/optimization/utilization', { params });
  }

  // ─── Sprint 8 (Palier B) — Réservations ───

  /** GET /api/reservations — réservations scopées (status=REQUESTED = file de validation). */
  listReservations(filters?: {
    status?: VehicleEventStatus;
    from?: string;
    to?: string;
    vehicleId?: string;
    groupId?: string;
  }): Observable<VehicleEventDto[]> {
    const params: Record<string, string> = {};
    if (filters?.status) params['status'] = filters.status;
    if (filters?.from) params['from'] = filters.from;
    if (filters?.to) params['to'] = filters.to;
    if (filters?.vehicleId) params['vehicleId'] = filters.vehicleId;
    if (filters?.groupId) params['groupId'] = filters.groupId;
    return this.http.get<VehicleEventDto[]>('/api/reservations', { params });
  }

  /** GET /api/reservations/suggest — véhicules libres + conformes aux critères. */
  suggestReservation(query: {
    startAt: string;
    endAt: string;
    minSeats?: number;
    minChildSeats?: number;
    features?: string[];
  }): Observable<SuggestReservationResultDto> {
    const params: Record<string, string> = { startAt: query.startAt, endAt: query.endAt };
    if (query.minSeats) params['minSeats'] = String(query.minSeats);
    if (query.minChildSeats) params['minChildSeats'] = String(query.minChildSeats);
    if (query.features?.length) params['features'] = query.features.join(',');
    return this.http.get<SuggestReservationResultDto>('/api/reservations/suggest', { params });
  }

  /** POST /api/reservations/request — déposer une demande (REQUESTED). */
  requestReservation(dto: RequestReservationDto): Observable<VehicleEventDto> {
    return this.http.post<VehicleEventDto>('/api/reservations/request', dto);
  }

  /** POST /api/reservations/:id/confirm — valider (CONFIRMED). */
  confirmReservation(id: string, dto: ConfirmReservationDto = {}): Observable<VehicleEventDto> {
    return this.http.post<VehicleEventDto>(`/api/reservations/${id}/confirm`, dto);
  }

  /** POST /api/reservations/:id/cancel — refuser / annuler (CANCELLED). */
  cancelReservation(id: string): Observable<VehicleEventDto> {
    return this.http.post<VehicleEventDto>(`/api/reservations/${id}/cancel`, {});
  }

  /** PATCH /api/reservations/:id — éditer (créneau / critères / libellé). */
  updateReservation(id: string, dto: UpdateReservationDto): Observable<VehicleEventDto> {
    return this.http.patch<VehicleEventDto>(`/api/reservations/${id}`, dto);
  }

  /** GET /api/agenda/forecast — usage PRÉVU (récurrence dérivée), projeté sur la fenêtre. */
  getForecast(query: { from: string; to: string }): Observable<ForecastResultDto> {
    return this.http.get<ForecastResultDto>('/api/agenda/forecast', {
      params: { from: query.from, to: query.to },
    });
  }
}
