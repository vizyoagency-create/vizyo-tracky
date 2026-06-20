import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/** Un IMEI qui tente de se connecter en GPRS mais n'est pas enregistré (→ retombe en SMS). */
export interface UnknownTrackerDto {
  imei: string;
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
  lastRemoteAddr: string | null;
}

@Injectable({ providedIn: 'root' })
export class UnknownTrackersApiService {
  private readonly http = inject(HttpClient);

  list(): Observable<UnknownTrackerDto[]> {
    return this.http.get<UnknownTrackerDto[]>('/api/admin/unknown-trackers');
  }

  forget(imei: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/admin/unknown-trackers/${encodeURIComponent(imei)}`);
  }
}
