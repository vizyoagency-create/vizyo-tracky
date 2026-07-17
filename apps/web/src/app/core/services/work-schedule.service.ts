import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/** Une journée du cadre (plage unique HH:MM côté UI ; le backend gère aussi le multi-plages). */
export interface WorkScheduleDayInput {
  enabled?: boolean;
  start?: string | null;
  end?: string | null;
}

export interface SetWorkScheduleBody {
  enabled: boolean;
  timezone?: string;
  countryCode?: string;
  days?: Record<string, WorkScheduleDayInput>;
}

/** Cadre renvoyé par le backend (champs par jour + méta). Accès dynamique `${day}Start`… */
export interface WorkScheduleRow {
  enabled: boolean;
  timezone: string;
  countryCode: string;
  [key: string]: unknown;
}

export interface WorkScheduleState {
  vehicleId: string;
  schedule: WorkScheduleRow | null;
  effective: { isPrivate: boolean; reason: string };
}

/**
 * Cadre de temps de travail par véhicule (usage mixte, RGPD) — client HTTP.
 * GET ouvert (vehicles_view) ; PUT réservé au cadre (schedules_manage).
 */
@Injectable({ providedIn: 'root' })
export class WorkScheduleApiService {
  private readonly http = inject(HttpClient);

  get(vehicleId: string): Observable<WorkScheduleState> {
    return this.http.get<WorkScheduleState>(`/api/vehicles/${vehicleId}/work-schedule`);
  }

  set(vehicleId: string, body: SetWorkScheduleBody): Observable<{ ok: true }> {
    return this.http.put<{ ok: true }>(`/api/vehicles/${vehicleId}/work-schedule`, body);
  }
}
