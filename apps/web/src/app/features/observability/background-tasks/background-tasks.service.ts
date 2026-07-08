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
}
