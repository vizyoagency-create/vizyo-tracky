import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';
import { catmullRom } from '../../shared/utils/spline';

export interface PositionDto {
  id: string;
  trackerId: string;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number;
  altitude: number | null;
  valid: boolean;
  ignition: boolean | null;
  timestamp: string;
}

export interface HistoryResponse {
  detail: 'fine' | 'compact';
  points: { lat: number; lng: number; timestamp?: string; speedKmh?: number }[];
  trips?: { id: string; startedAt: string; endedAt: string | null; pointCount: number }[];
}

export interface SmoothedHistoryResponse {
  detail: 'fine' | 'compact';
  rawPointCount: number;
  smoothPoints: { lat: number; lng: number }[];
  trips?: HistoryResponse['trips'];
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

  /**
   * V1.5 (Sprint H4) — historique avec compaction adaptative.
   *
   * `detail = auto` (defaut) renvoie la table positions brute pour les ranges
   * courts (< 24h) et les polylignes Trip.polyline (Douglas-Peucker eps=5m)
   * pour les ranges plus longs.
   */
  history(params: {
    trackerId?: string;
    vehicleId?: string;
    from: string;
    to: string;
    detail?: 'auto' | 'fine' | 'compact';
  }): Observable<HistoryResponse> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') clean[k] = String(v);
    }
    return this.http.get<HistoryResponse>('/api/positions/history', { params: clean });
  }

  /**
   * V1.5 (Sprint H4) — variante de `history()` qui applique un lissage Catmull-Rom
   * aux points compactes pour eviter l'effet "lignes droites" en zone urbaine.
   *
   * Le lissage n'est applique qu'au niveau `compact` — les points `fine` sont
   * deja a 30s d'intervalle, suffisamment denses pour ne pas necessiter de spline.
   * `samplesPerSegment` controle la finesse (defaut 6 = 6 points entre chaque
   * couple de points originaux, bon compromis fluidite / cout).
   */
  historySmoothed(
    params: Parameters<PositionsApiService['history']>[0],
    samplesPerSegment = 6,
  ): Observable<SmoothedHistoryResponse> {
    return this.history(params).pipe(
      map((res) => ({
        detail: res.detail,
        rawPointCount: res.points.length,
        smoothPoints:
          res.detail === 'compact' && res.points.length >= 3
            ? catmullRom(res.points, samplesPerSegment)
            : res.points.map((p) => ({ lat: p.lat, lng: p.lng })),
        trips: res.trips,
      })),
    );
  }
}
