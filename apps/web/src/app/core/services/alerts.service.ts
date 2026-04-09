import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { AlertEvent } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AlertsApiService {
  private readonly http = inject(HttpClient);

  list(params: Record<string, string> = {}): Observable<{ items: AlertEvent[]; nextCursor: string | null }> {
    return this.http.get<{ items: AlertEvent[]; nextCursor: string | null }>('/api/alerts', { params });
  }

  count(): Observable<{ total: number; critical: number }> {
    return this.http.get<{ total: number; critical: number }>('/api/alerts/unacknowledged/count');
  }

  acknowledge(id: string): Observable<AlertEvent> {
    return this.http.post<AlertEvent>(`/api/alerts/${id}/acknowledge`, {});
  }

  acknowledgeAll(): Observable<{ count: number }> {
    return this.http.post<{ count: number }>('/api/alerts/acknowledge-all', {});
  }
}
