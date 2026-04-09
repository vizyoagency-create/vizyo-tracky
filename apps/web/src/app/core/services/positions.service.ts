import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface PositionDto {
  id: string;
  trackerId: string;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number;
  altitude: number | null;
  valid: boolean;
  timestamp: string;
}

@Injectable({ providedIn: 'root' })
export class PositionsApiService {
  private readonly http = inject(HttpClient);

  list(params: Record<string, string>): Observable<{ items: PositionDto[]; nextCursor: string | null }> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') clean[k] = v;
    }
    return this.http.get<{ items: PositionDto[]; nextCursor: string | null }>('/api/positions', { params: clean });
  }
}
