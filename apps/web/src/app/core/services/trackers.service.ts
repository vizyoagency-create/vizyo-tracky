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
  vehicle: { id: string; plate: string; fleetId: string } | null;
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

  list(params?: Record<string, string>): Observable<TrackerDetail[]> {
    return this.http.get<TrackerDetail[]>('/api/trackers', { params });
  }
}
