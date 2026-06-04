import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface TrackerDetail {
  id: string;
  imei: string;
  model: string;
  status: string;
  lastSeenAt: string | null;
  vehicleId: string | null;
  vehicle: { id: string; plate: string; fleetId: string; fleet?: { id: string; name: string } } | null;
  /** V1.7 — fil ACC connecte (true) ou ignition inferee depuis vitesse (false). */
  accConnected: boolean;
  /** V1.14 — numero SIM data (E.164) pour fallback SMS + allowlist vizyo-texto. */
  simPhoneNumber: string | null;
}

export interface UpdateTrackerPayload {
  model?: string;
  /** V1.7 — toggle SUPER_ADMIN. Backend rejette en 403 pour les autres roles. */
  accConnected?: boolean;
  /** V1.14 — numero SIM (E.164) ou '' pour effacer. */
  simPhoneNumber?: string;
}

@Injectable({ providedIn: 'root' })
export class TrackersApiService {
  private readonly http = inject(HttpClient);

  create(data: { imei: string; model?: string }): Observable<TrackerDetail> {
    return this.http.post<TrackerDetail>('/api/trackers', data);
  }

  assign(trackerId: string, vehicleId: string): Observable<TrackerDetail> {
    return this.http.post<TrackerDetail>(`/api/trackers/${trackerId}/assign`, { vehicleId });
  }

  unassign(trackerId: string): Observable<TrackerDetail> {
    return this.http.post<TrackerDetail>(`/api/trackers/${trackerId}/unassign`, {});
  }

  list(params?: Record<string, string>): Observable<TrackerDetail[]> {
    return this.http.get<TrackerDetail[]>('/api/trackers', { params });
  }

  /** V1.7 — update partiel (model + accConnected). accConnected = SUPER_ADMIN only. */
  update(id: string, payload: UpdateTrackerPayload): Observable<TrackerDetail> {
    return this.http.patch<TrackerDetail>(`/api/trackers/${id}`, payload);
  }
}
