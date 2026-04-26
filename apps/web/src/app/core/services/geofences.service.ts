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
  }): Observable<GeofenceDto> {
    return this.http.post<GeofenceDto>('/api/geofences', data);
  }

  update(id: string, data: Record<string, unknown>): Observable<GeofenceDto> {
    return this.http.patch<GeofenceDto>(`/api/geofences/${id}`, data);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`/api/geofences/${id}`);
  }
}
