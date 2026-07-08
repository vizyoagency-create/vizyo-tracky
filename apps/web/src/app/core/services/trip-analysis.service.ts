import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { AiProviderId, DrivingScoreDetailDto, DrivingScoreScope, DrivingScoresDto, FuelFillUpDto, FuelStationMapPointDto, TripAnalysisDto, TripNarrativeCompareDto, UpsertFuelFillUpDto, VehicleFuelModelDto, VehicleFuelReportDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Traçabilité fine des trajets (Palier 2/4) — client HTTP de l'analyse déterministe d'un trajet
 * (arrêts, excès de vitesse, éco-conduite, conso). Réutilisé partout : fiche véhicule (onglet
 * Trajets), Rapports, Replay. Le service serveur applique le scoping véhicule (anti-IDOR).
 */
@Injectable({ providedIn: 'root' })
export class TripAnalysisApiService {
  private readonly http = inject(HttpClient);

  /** Lit l'analyse persistée d'un trajet (null si jamais calculée). */
  get(tripId: string): Observable<TripAnalysisDto | null> {
    return this.http.get<TripAnalysisDto | null>(`/api/trip-analysis/${encodeURIComponent(tripId)}`);
  }

  /** (Ré)analyse un trajet et persiste. */
  analyze(tripId: string): Observable<TripAnalysisDto> {
    return this.http.post<TripAnalysisDto>(`/api/trip-analysis/${encodeURIComponent(tripId)}`, {});
  }

  /** Analyses récentes d'un véhicule (pour pré-charger l'onglet Trajets d'un coup). */
  listForVehicle(vehicleId: string, limit = 100): Observable<TripAnalysisDto[]> {
    return this.http.get<TripAnalysisDto[]>(`/api/trip-analysis/vehicle/${encodeURIComponent(vehicleId)}`, { params: { limit: String(limit) } });
  }

  /** Génère (ou régénère) le récit IA + Trust Score + conseils d'un trajet. `provider` optionnel. */
  narrate(tripId: string, provider?: AiProviderId): Observable<TripAnalysisDto> {
    return this.http.post<TripAnalysisDto>(`/api/trip-analysis/${encodeURIComponent(tripId)}/narrate`, provider ? { provider } : {});
  }

  /** Mode « Comparer » : le même trajet analysé par Claude ET GPT (admin). */
  compare(tripId: string): Observable<TripNarrativeCompareDto> {
    return this.http.post<TripNarrativeCompareDto>(`/api/trip-analysis/${encodeURIComponent(tripId)}/compare`, {});
  }

  /** Classement noté du score de conduite par véhicule / conducteur / groupe. */
  scores(scope: DrivingScoreScope, from?: string, to?: string, fleetId?: string): Observable<DrivingScoresDto> {
    const params: Record<string, string> = { scope };
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    if (fleetId) params['fleetId'] = fleetId;
    return this.http.get<DrivingScoresDto>('/api/trip-analysis/scores', { params });
  }

  /** Score PERSO d'une entité (rang + vs moyenne) — carte dans les fiches détail. */
  entityScore(scope: DrivingScoreScope, id: string, from?: string, to?: string): Observable<DrivingScoreDetailDto> {
    const params: Record<string, string> = {};
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    return this.http.get<DrivingScoreDetailDto>(`/api/trip-analysis/scores/${scope}/${encodeURIComponent(id)}`, { params });
  }

  /** Suivi carburant d'un véhicule (passages station, prix constatés, coût estimé vs prix flotte). */
  fuelReport(vehicleId: string, from?: string, to?: string): Observable<VehicleFuelReportDto> {
    const params: Record<string, string> = {};
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    return this.http.get<VehicleFuelReportDto>(`/api/trip-analysis/fuel-report/${encodeURIComponent(vehicleId)}`, { params });
  }

  /** Stations agrégées (passages de toute la flotte) pour la carte : fréquence + récence d'usage. */
  fuelStationsMap(from?: string, to?: string): Observable<FuelStationMapPointDto[]> {
    const params: Record<string, string> = {};
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    return this.http.get<FuelStationMapPointDto[]>('/api/trip-analysis/fuel-stations/map', { params });
  }

  /** Modèle carburant CALIBRÉ d'un véhicule (conso estimée vs réelle « méthode du plein » + coûts). */
  fuelCalibration(vehicleId: string, from?: string, to?: string): Observable<VehicleFuelModelDto> {
    const params: Record<string, string> = {};
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    return this.http.get<VehicleFuelModelDto>(`/api/trip-analysis/fuel-calibration/${encodeURIComponent(vehicleId)}`, { params });
  }

  /** Enregistre un plein (méthode du plein) → recalibre la conso réelle du véhicule. */
  createFillUp(dto: UpsertFuelFillUpDto): Observable<FuelFillUpDto> {
    return this.http.post<FuelFillUpDto>('/api/trip-analysis/fuel-fill-up', dto);
  }
  /** Met à jour un plein. */
  updateFillUp(id: string, dto: UpsertFuelFillUpDto): Observable<FuelFillUpDto> {
    return this.http.put<FuelFillUpDto>(`/api/trip-analysis/fuel-fill-up/${encodeURIComponent(id)}`, dto);
  }
  /** Supprime un plein. */
  deleteFillUp(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/trip-analysis/fuel-fill-up/${encodeURIComponent(id)}`);
  }
}
