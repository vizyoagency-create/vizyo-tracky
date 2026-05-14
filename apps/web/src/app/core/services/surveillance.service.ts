import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type SurveillanceMode = 'OFF' | 'FULL_TIME' | 'SCHEDULED';
export type SurveillanceSensitivity = 'LOW' | 'MEDIUM' | 'HIGH';
export type SurveillanceEventTrigger = 'VIBRATION' | 'MOVEMENT' | 'DOOR';
export type SurveillanceEventStatus =
  | 'PENDING'
  | 'ACKNOWLEDGED'
  | 'CONFIRMED_THEFT'
  | 'FALSE_ALARM';

export interface SurveillanceProfileDto {
  id: string;
  vehicleId: string;
  fleetId: string;
  mode: SurveillanceMode;
  sensitivity: SurveillanceSensitivity;
  scheduleStartTime: string | null;
  scheduleEndTime: string | null;
  scheduleDays: string[] | null;
  triggerVibration: boolean;
  triggerMovement: boolean;
  triggerDoor: boolean;
  additionalNotifyUserIds: string[];
  currentlyArmed: boolean;
  lastArmedAt: string | null;
  lastDisarmedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SurveillanceEventDto {
  id: string;
  profileId: string;
  vehicleId: string;
  fleetId: string;
  alertId: string | null;
  trigger: SurveillanceEventTrigger;
  triggeredAt: string;
  latitude: number | null;
  longitude: number | null;
  speedKmh: number | null;
  status: SurveillanceEventStatus;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  notes: string | null;
  createdAt: string;
  vehicle?: { id: string; plate: string };
}

export interface UpdateProfileDto {
  mode?: SurveillanceMode;
  sensitivity?: SurveillanceSensitivity;
  scheduleStartTime?: string | null;
  scheduleEndTime?: string | null;
  scheduleDays?: string[] | null;
  triggerVibration?: boolean;
  triggerMovement?: boolean;
  triggerDoor?: boolean;
  additionalNotifyUserIds?: string[];
}

export interface AcknowledgeEventDto {
  status: SurveillanceEventStatus;
  notes?: string;
}

@Injectable({ providedIn: 'root' })
export class SurveillanceApiService {
  private readonly http = inject(HttpClient);

  getProfile(vehicleId: string): Observable<SurveillanceProfileDto> {
    return this.http.get<SurveillanceProfileDto>(
      `/api/surveillance/profiles/${vehicleId}`,
    );
  }

  updateProfile(
    vehicleId: string,
    dto: UpdateProfileDto,
  ): Observable<SurveillanceProfileDto> {
    return this.http.put<SurveillanceProfileDto>(
      `/api/surveillance/profiles/${vehicleId}`,
      dto,
    );
  }

  arm(vehicleId: string): Observable<SurveillanceProfileDto> {
    return this.http.post<SurveillanceProfileDto>(
      `/api/surveillance/profiles/${vehicleId}/arm`,
      {},
    );
  }

  disarm(vehicleId: string): Observable<SurveillanceProfileDto> {
    return this.http.post<SurveillanceProfileDto>(
      `/api/surveillance/profiles/${vehicleId}/disarm`,
      {},
    );
  }

  listEvents(
    params: Record<string, string> = {},
  ): Observable<{ items: SurveillanceEventDto[]; nextCursor: string | null }> {
    return this.http.get<{
      items: SurveillanceEventDto[];
      nextCursor: string | null;
    }>('/api/surveillance/events', { params });
  }

  acknowledgeEvent(
    id: string,
    dto: AcknowledgeEventDto,
  ): Observable<SurveillanceEventDto> {
    return this.http.post<SurveillanceEventDto>(
      `/api/surveillance/events/${id}/acknowledge`,
      dto,
    );
  }
}
