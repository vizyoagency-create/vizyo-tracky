import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  DbStatsDto,
  SystemHistoryDto,
  SystemRange,
  SystemSnapshotDto,
} from '@vizyo/tracky-shared';

/** Client REST du monitoring VPS (espace admin, SUPER_ADMIN). */
@Injectable({ providedIn: 'root' })
export class SystemMetricsApiService {
  private readonly http = inject(HttpClient);

  current(): Observable<SystemSnapshotDto> {
    return this.http.get<SystemSnapshotDto>('/api/admin/system/current');
  }

  history(range: SystemRange): Observable<SystemHistoryDto> {
    return this.http.get<SystemHistoryDto>('/api/admin/system/history', { params: { range } });
  }

  db(): Observable<DbStatsDto> {
    return this.http.get<DbStatsDto>('/api/admin/system/db');
  }
}
