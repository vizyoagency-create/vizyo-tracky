import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

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

  lastEvaluatedState: string | null;
  overrideUntil: string | null;
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
}
