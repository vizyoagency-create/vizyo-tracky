import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Lieux clés (2026-07) — référentiel des lieux de la flotte : stations-service VALIDÉES par
 * l'exploitant et parkings / stationnements récurrents posés à la main. DTO définis localement
 * (même convention que VehicleDetailDto / GpsDeadZoneDto).
 */
export type FleetPlaceKind = 'FUEL_STATION' | 'PARKING' | 'DEPOT' | 'OTHER';

export interface FleetPlaceDto {
  id: string;
  fleetId: string;
  name: string;
  kind: FleetPlaceKind;
  lat: number;
  lng: number;
  radiusM: number;
  note: string | null;
  /** Station d'origine si le lieu vient de la validation d'une station détectée. */
  stationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Un passage en station-service avec un VRAI arrêt (≥ 4 min par défaut). */
export interface StationPassageDto {
  id: string;
  at: string;
  vehicleId: string;
  plate: string | null;
  stationId: string;
  brand: string | null;
  name: string | null;
  city: string | null;
  address: string | null;
  lat: number;
  lng: number;
  durationMin: number;
  distanceM: number;
  priceEur: number | null;
  fuelType: string | null;
  /** true si la station fait déjà partie des lieux de la flotte. */
  validated: boolean;
}

@Injectable({ providedIn: 'root' })
export class FleetPlacesApiService {
  private readonly http = inject(HttpClient);

  /** Lieux clés de la flotte (stations validées + parkings + dépôts). */
  list(fleetId?: string): Observable<FleetPlaceDto[]> {
    const params: Record<string, string> = {};
    if (fleetId) params['fleetId'] = fleetId;
    return this.http.get<FleetPlaceDto[]>('/api/fleet-places', { params });
  }

  /** Passages station avec arrêt réel (≥ minStopMin, 4 min par défaut). */
  stationPassages(opts: { from?: string; to?: string; fleetId?: string; minStopMin?: number } = {}): Observable<StationPassageDto[]> {
    const params: Record<string, string> = {};
    if (opts.from) params['from'] = opts.from;
    if (opts.to) params['to'] = opts.to;
    if (opts.fleetId) params['fleetId'] = opts.fleetId;
    if (opts.minStopMin != null) params['minStopMin'] = String(opts.minStopMin);
    return this.http.get<StationPassageDto[]>('/api/fleet-places/station-passages', { params });
  }

  /** Crée un lieu : parking posé à la main, ou validation d'une station détectée. */
  create(data: {
    name: string;
    kind: FleetPlaceKind;
    lat: number;
    lng: number;
    radiusM?: number;
    note?: string | null;
    stationId?: string | null;
    fleetId?: string;
  }): Observable<FleetPlaceDto> {
    return this.http.post<FleetPlaceDto>('/api/fleet-places', data);
  }

  update(id: string, data: Partial<{ name: string; kind: FleetPlaceKind; lat: number; lng: number; radiusM: number; note: string | null }>): Observable<FleetPlaceDto> {
    return this.http.patch<FleetPlaceDto>(`/api/fleet-places/${id}`, data);
  }

  remove(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/fleet-places/${id}`);
  }
}
