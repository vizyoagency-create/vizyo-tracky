import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type { BackgroundTasksResponse } from '@vizyo/tracky-shared';

@Injectable({ providedIn: 'root' })
export class BackgroundTasksApiService {
  private readonly http = inject(HttpClient);

  list(): Observable<BackgroundTasksResponse> {
    return this.http.get<BackgroundTasksResponse>('/api/admin/background-tasks');
  }

  /** T34 — lève la pause des agents du poste ; rend le nombre de lignes fermées. */
  reprendreAgents(): Observable<{ levees: number }> {
    return this.http.post<{ levees: number }>('/api/admin/background-tasks/agents-locaux/reprendre', {});
  }
}
