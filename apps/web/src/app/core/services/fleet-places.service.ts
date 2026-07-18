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

/** Un véhicule passé par une station + son nombre de passages. */
export interface StationGroupVehicleDto {
  vehicleId: string;
  plate: string | null;
  visits: number;
  lastAt: string;
}

/** Une STATION regroupée (une ligne par lieu) : qui est passé, combien de fois, quand. */
export interface StationGroupDto {
  stationId: string;
  /** Libellé prêt à afficher (jamais vide, même si la marque est absente du catalogue). */
  label: string;
  brand: string | null;
  name: string | null;
  city: string | null;
  address: string | null;
  lat: number;
  lng: number;
  passages: number;
  distinctVehicles: number;
  vehicles: StationGroupVehicleDto[];
  firstAt: string;
  lastAt: string;
  avgStopMin: number;
  lastPriceEur: number | null;
  fuelType: string | null;
  /** Lieu de la flotte correspondant si la station est validée (sinon null). */
  placeId: string | null;
  placeName: string | null;
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

  /** Stations REGROUPÉES (une par lieu) avec arrêt réel ≥ minStopMin (4 min par défaut). */
  stationGroups(opts: { from?: string; to?: string; fleetId?: string; minStopMin?: number } = {}): Observable<StationGroupDto[]> {
    const params: Record<string, string> = {};
    if (opts.from) params['from'] = opts.from;
    if (opts.to) params['to'] = opts.to;
    if (opts.fleetId) params['fleetId'] = opts.fleetId;
    if (opts.minStopMin != null) params['minStopMin'] = String(opts.minStopMin);
    return this.http.get<StationGroupDto[]>('/api/fleet-places/stations', { params });
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
