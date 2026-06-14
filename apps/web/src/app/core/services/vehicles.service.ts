import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { DriverSummaryDto } from '@vizyo/tracky-shared';
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
    /** V1.7 — fil ACC connecte (true) ou ignition inferee depuis vitesse (false). */
    accConnected: boolean;
    /** V1.15 — n° SIM data (E.164). Avec l'IMEI, determine le statut « Installé ». */
    simPhoneNumber?: string | null;
  } | null;
  /** Phase 2 — Conducteur courant (defaut snape sur prochains trajets). null = aucun. */
  currentDriver?: DriverSummaryDto | null;
  createdAt: string;
  schedule?: { enabled: boolean } | null;
  /** Sprint 1 (Fondation Groupes) — groupe (unique) du véhicule. null = sans groupe. */
  group?: { id: string; name: string } | null;
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

  /**
   * Sprint 1 (Fondation Groupes) — définit/retire le groupe (single) du véhicule.
   * `groupId: null` retire le véhicule de son groupe (« sans groupe »).
   */
  setGroup(id: string, groupId: string | null): Observable<VehicleDetailDto> {
    return this.http.patch<VehicleDetailDto>(`/api/vehicles/${id}/group`, { groupId });
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
