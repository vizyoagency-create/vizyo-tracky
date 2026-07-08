import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  BulkScheduleApplyResponse,
  BulkSchedulePreviewResponse,
  FleetScheduleListResponse,
} from '@vizyo/tracky-shared';

export interface ScheduleSlot {
  start: string;
  end: string;
}

export interface ScheduleCustomDate {
  date: string;
  closed?: boolean;
  slots?: ScheduleSlot[];
}

export interface VehicleScheduleDto {
  id: string;
  vehicleId: string;
  enabled: boolean;
  timezone: string;

  mondayEnabled: boolean;
  mondayStart: string | null;
  mondayEnd: string | null;
  tuesdayEnabled: boolean;
  tuesdayStart: string | null;
  tuesdayEnd: string | null;
  wednesdayEnabled: boolean;
  wednesdayStart: string | null;
  wednesdayEnd: string | null;
  thursdayEnabled: boolean;
  thursdayStart: string | null;
  thursdayEnd: string | null;
  fridayEnabled: boolean;
  fridayStart: string | null;
  fridayEnd: string | null;
  saturdayEnabled: boolean;
  saturdayStart: string | null;
  saturdayEnd: string | null;
  sundayEnabled: boolean;
  sundayStart: string | null;
  sundayEnd: string | null;

  // V1.5 (Sprint K)
  mondaySlots: ScheduleSlot[] | null;
  tuesdaySlots: ScheduleSlot[] | null;
  wednesdaySlots: ScheduleSlot[] | null;
  thursdaySlots: ScheduleSlot[] | null;
  fridaySlots: ScheduleSlot[] | null;
  saturdaySlots: ScheduleSlot[] | null;
  sundaySlots: ScheduleSlot[] | null;
  countryCode: string;
  customDates: ScheduleCustomDate[] | null;

  lastEvaluatedState: string | null;
  overrideUntil: string | null;
}

export interface ScheduleHistoryItem {
  id: string;
  scheduleId: string;
  vehicleId: string;
  occurredAt: string;
  action: 'CUT' | 'RESTORE';
  reason: string;
  windowDesc: string | null;
}

export interface UpsertSchedulePayload {
  enabled: boolean;
  timezone: string;
  mondayEnabled: boolean;
  mondayStart: string | null;
  mondayEnd: string | null;
  tuesdayEnabled: boolean;
  tuesdayStart: string | null;
  tuesdayEnd: string | null;
  wednesdayEnabled: boolean;
  wednesdayStart: string | null;
  wednesdayEnd: string | null;
  thursdayEnabled: boolean;
  thursdayStart: string | null;
  thursdayEnd: string | null;
  fridayEnabled: boolean;
  fridayStart: string | null;
  fridayEnd: string | null;
  saturdayEnabled: boolean;
  saturdayStart: string | null;
  saturdayEnd: string | null;
  sundayEnabled: boolean;
  sundayStart: string | null;
  sundayEnd: string | null;
  // V1.5 (Sprint K) — multi-plages + jours feries + custom dates (optionnels)
  mondaySlots?: ScheduleSlot[];
  tuesdaySlots?: ScheduleSlot[];
  wednesdaySlots?: ScheduleSlot[];
  thursdaySlots?: ScheduleSlot[];
  fridaySlots?: ScheduleSlot[];
  saturdaySlots?: ScheduleSlot[];
  sundaySlots?: ScheduleSlot[];
  countryCode?: string;
  customDates?: ScheduleCustomDate[];
}

@Injectable({ providedIn: 'root' })
export class VehicleSchedulesApiService {
  private readonly http = inject(HttpClient);

  get(vehicleId: string): Observable<VehicleScheduleDto | null> {
    return this.http.get<VehicleScheduleDto | null>(
      `/api/vehicles/${vehicleId}/schedule`,
    );
  }

  upsert(
    vehicleId: string,
    data: UpsertSchedulePayload,
  ): Observable<VehicleScheduleDto> {
    return this.http.put<VehicleScheduleDto>(
      `/api/vehicles/${vehicleId}/schedule`,
      data,
    );
  }

  /** V1.5 (Sprint K) — timeline des transitions auto sur 90j. */
  history(vehicleId: string, limit = 100): Observable<{ items: ScheduleHistoryItem[] }> {
    return this.http.get<{ items: ScheduleHistoryItem[] }>(
      `/api/vehicles/${vehicleId}/schedule/history`,
      { params: { limit: String(limit) } },
    );
  }

  // ─── Demande CDEF (2026-07) — Page flotte « Horaires » (vue d'ensemble + actions de masse) ───

  /** Vue d'ensemble : 1 ligne par véhicule (config + état live + compte-à-rebours). */
  listFleet(): Observable<FleetScheduleListResponse> {
    return this.http.get<FleetScheduleListResponse>('/api/fleet-schedules');
  }

  /** Aperçu d'un bulk AVANT application (combien seraient coupés maintenant, etc.). */
  bulkPreview(payload: {
    fleetId?: string;
    vehicleIds?: string[];
    schedule: UpsertSchedulePayload;
  }): Observable<BulkSchedulePreviewResponse> {
    return this.http.post<BulkSchedulePreviewResponse>('/api/fleet-schedules/bulk/preview', payload);
  }

  /** Applique un bulk (activer/désactiver + poser des horaires) sur le périmètre autorisé. */
  bulkApply(payload: {
    fleetId?: string;
    vehicleIds?: string[];
    schedule: UpsertSchedulePayload;
  }): Observable<BulkScheduleApplyResponse> {
    return this.http.post<BulkScheduleApplyResponse>('/api/fleet-schedules/bulk', payload);
  }
}
