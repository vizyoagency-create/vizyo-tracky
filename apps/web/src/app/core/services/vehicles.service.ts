import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface VehicleDetailDto {
  id: string;
  plate: string;
  type: string;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  fleetId: string;
  tracker: {
    id: string;
    imei: string;
    status: string;
    lastSeenAt: string | null;
    lastKnownIgnition: boolean | null;
  } | null;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class VehiclesApiService {
  private readonly http = inject(HttpClient);

  findOne(id: string): Observable<VehicleDetailDto> {
    return this.http.get<VehicleDetailDto>(`/api/vehicles/${id}`);
  }

  create(data: {
    plate: string;
    type?: 'CAR' | 'TRUCK' | 'VAN' | 'MOTORCYCLE' | 'BICYCLE' | 'BUS' | 'CONSTRUCTION' | 'OTHER';
    brand?: string;
    model?: string;
    year?: number;
    color?: string;
    fleetId?: string;
  }): Observable<VehicleDetailDto> {
    return this.http.post<VehicleDetailDto>('/api/vehicles', data);
  }

  list(params?: Record<string, string>): Observable<VehicleDetailDto[]> {
    return this.http.get<VehicleDetailDto[]>('/api/vehicles', { params });
  }

  update(id: string, data: Record<string, unknown>): Observable<VehicleDetailDto> {
    return this.http.patch<VehicleDetailDto>(`/api/vehicles/${id}`, data);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`/api/vehicles/${id}`);
  }

  stats(): Observable<VehicleStatsDto> {
    return this.http.get<VehicleStatsDto>('/api/vehicles/stats');
  }
}

export interface VehicleStatsDto {
  total: number;
  moving: number;
  idle: number;
  criticalAlerts: number;
  newThisMonth: number;
}
