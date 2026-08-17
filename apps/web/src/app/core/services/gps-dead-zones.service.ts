import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Zones mortes GPS (suivi FS-253) — endroits où un véhicule perd récurremment son lock GPS
 * (parking souterrain/couvert, tunnel, brouilleur). DTO définis localement (comme VehicleDetailDto),
 * les valeurs de statut/nature reflètent les enums Prisma côté API.
 */
export type GpsDeadZoneStatus = 'LEARNING' | 'RECURRING' | 'CONFIRMED_BENIGN' | 'SUSPECT';
export type GpsDeadZoneLabel =
  | 'UNKNOWN'
  | 'UNDERGROUND_PARKING'
  | 'COVERED_PARKING'
  | 'TUNNEL'
  | 'JAMMER_SUSPECTED'
  | 'OTHER';

export interface GpsDeadZoneEventDto {
  lat: number;
  lng: number;
  lostAt: string;
  detectedAt: string;
  /** TRK-028 — retour du signal, ou `null` si l'épisode est encore ouvert. */
  recoveredAt: string | null;
}

export interface GpsDeadZoneDto {
  id: string;
  vehicleId: string;
  fleetId: string;
  centroidLat: number;
  centroidLng: number;
  radiusM: number;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: GpsDeadZoneStatus;
  label: GpsDeadZoneLabel;
  /** Nature suggérée (heuristique) tant que l'opérateur n'a pas qualifié la zone. */
  suggestedLabel: GpsDeadZoneLabel | null;
  placeLabel: string | null;
  note: string | null;
  reviewedAt: string | null;
  /**
   * TRK-028 — durée MÉDIANE d'une absence sur cette zone, en minutes. `null` tant qu'aucun
   * épisode n'a été vu se refermer : l'écran n'annonce alors aucune durée.
   */
  typicalOutageMinutes: number | null;
  recentEvents: GpsDeadZoneEventDto[];
}

/** Zone morte allégée pour la carte (marqueur parking souterrain), avec la plaque du véhicule. */
export interface GpsDeadZoneMapDto {
  id: string;
  vehicleId: string;
  plate: string | null;
  centroidLat: number;
  centroidLng: number;
  radiusM: number;
  occurrences: number;
  status: GpsDeadZoneStatus;
  label: GpsDeadZoneLabel;
  suggestedLabel: GpsDeadZoneLabel | null;
  placeLabel: string | null;
}

@Injectable({ providedIn: 'root' })
export class GpsDeadZonesApiService {
  private readonly http = inject(HttpClient);

  /** Zones mortes GPS apprises pour un véhicule (triées par récurrence). */
  listForVehicle(vehicleId: string): Observable<GpsDeadZoneDto[]> {
    return this.http.get<GpsDeadZoneDto[]>('/api/gps-dead-zones', { params: { vehicleId } });
  }

  /** Zones mortes GPS de la flotte pour la carte (parkings souterrains + zones récurrentes/suspectes). */
  listForMap(fleetId?: string): Observable<GpsDeadZoneMapDto[]> {
    const params: Record<string, string> = {};
    if (fleetId) params['fleetId'] = fleetId;
    return this.http.get<GpsDeadZoneMapDto[]>('/api/gps-dead-zones/map', { params });
  }

  /** Revue opérateur : confirmer « normal » (parking) / marquer suspect / qualifier la zone. */
  review(
    id: string,
    data: { status?: GpsDeadZoneStatus; label?: GpsDeadZoneLabel; note?: string | null },
  ): Observable<GpsDeadZoneDto> {
    return this.http.patch<GpsDeadZoneDto>(`/api/gps-dead-zones/${id}`, data);
  }
}
