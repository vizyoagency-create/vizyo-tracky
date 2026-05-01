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

  /**
   * Met a jour la note libre d'un trajet. Passer null ou chaine vide efface
   * la note (et reset auteur cote backend). Retourne le trajet a jour avec
   * `notes`, `notesUpdatedAt` et `notesUpdatedBy` rafraichis.
   */
  updateNote(id: string, notes: string | null): Observable<TripDto> {
    return this.http.patch<TripDto>(`/api/trips/${id}/notes`, { notes });
  }
}
