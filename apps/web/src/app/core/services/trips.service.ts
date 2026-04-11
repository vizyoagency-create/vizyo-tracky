import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { TripDailySummaryDto, TripDto, TripRecomputeResultDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class TripsApiService {
  private readonly http = inject(HttpClient);

  list(params: Record<string, string>): Observable<{ items: TripDto[]; nextCursor: string | null }> {
    return this.http.get<{ items: TripDto[]; nextCursor: string | null }>('/api/trips', { params });
  }

  findOne(id: string): Observable<TripDto> {
    return this.http.get<TripDto>(`/api/trips/${id}`);
  }

  dailySummary(params: Record<string, string>): Observable<TripDailySummaryDto[]> {
    return this.http.get<TripDailySummaryDto[]>('/api/trips/daily-summary', { params });
  }

  recompute(data: { vehicleId: string; from: string; to: string }): Observable<TripRecomputeResultDto> {
    return this.http.post<TripRecomputeResultDto>('/api/trips/recompute', data);
  }
}
