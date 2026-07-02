import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  ActivityReportDto,
  ActivityReportListItemDto,
  ActivityReportScheduleDto,
  GenerateActivityReportDto,
  SetActivityReportScheduleDto,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/** Palier 3 — client des rapports d'observation IA (SUPER_ADMIN). */
@Injectable({ providedIn: 'root' })
export class ActivityReportApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/admin/activity/reports';

  generate(body: GenerateActivityReportDto): Observable<ActivityReportDto> {
    return this.http.post<ActivityReportDto>(`${this.base}/generate`, body);
  }
  list(limit = 30): Observable<ActivityReportListItemDto[]> {
    return this.http.get<ActivityReportListItemDto[]>(this.base, { params: { limit: String(limit) } });
  }
  get(id: string): Observable<ActivityReportDto> {
    return this.http.get<ActivityReportDto>(`${this.base}/${id}`);
  }
  delete(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`${this.base}/${id}`);
  }
  getSchedule(): Observable<ActivityReportScheduleDto> {
    return this.http.get<ActivityReportScheduleDto>(`${this.base}/schedule`);
  }
  setSchedule(body: SetActivityReportScheduleDto): Observable<ActivityReportScheduleDto> {
    return this.http.put<ActivityReportScheduleDto>(`${this.base}/schedule`, body);
  }
}
