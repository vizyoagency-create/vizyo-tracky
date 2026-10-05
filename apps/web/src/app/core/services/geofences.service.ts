import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { GeofenceDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class GeofencesApiService {
  private readonly http = inject(HttpClient);

  list(): Observable<GeofenceDto[]> {
    return this.http.get<GeofenceDto[]>('/api/geofences');
  }

  findOne(id: string): Observable<GeofenceDto> {
    return this.http.get<GeofenceDto>(`/api/geofences/${id}`);
  }

  create(data: {
    name: string;
    type?: 'CIRCLE' | 'POLYGON';
    centerLat: number;
    centerLng: number;
    radiusMeters: number;
    rule: 'ENTER' | 'EXIT' | 'BOTH';
    color?: string;
    polygonPoints?: Array<{ lat: number; lng: number }>;
    /** Société de la zone — exigée pour un super-admin (`FleetFilterService.societePourCreer`). */
    fleetId?: string;
  }): Observable<GeofenceDto> {
    return this.http.post<GeofenceDto>('/api/geofences', data);
  }

  /** Import GeoJSON ; `fleetId` = société des zones, exigée pour un super-admin. */
  importGeoJson(json: unknown, fleetId?: string): Observable<{ created: number; skipped: number }> {
    return this.http.post<{ created: number; skipped: number }>(
      '/api/geofences/import-geojson',
      json,
      fleetId ? { params: { fleetId } } : {},
    );
  }

  update(id: string, data: Record<string, unknown>): Observable<GeofenceDto> {
    return this.http.patch<GeofenceDto>(`/api/geofences/${id}`, data);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`/api/geofences/${id}`);
  }
}
