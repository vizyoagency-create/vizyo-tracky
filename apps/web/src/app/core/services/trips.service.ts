import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  TripDailySummaryDto,
  TripDto,
  TripPeriodChartsDto,
  TripRecomputeResultDto,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class TripsApiService {
  private readonly http = inject(HttpClient);

  /**
   * Liste de trajets.
   *
   * Paramètres reconnus par le serveur (`ListTripsDto`) : `vehicleId`, `vehicleIds`, `from`,
   * `to`, `limit`, `cursor`, `fleetId`, `sortBy`, `sortDir`, `light` et — depuis F13 —
   * `driverId`, qui vaut un identifiant de conducteur ou `none` pour les trajets SANS
   * conducteur.
   *
   * ⚠️ `driverId` doit être posé sur CETTE requête ET sur les agrégats ci-dessous : un
   * tableau filtré sous des compteurs qui ne le sont pas, c'est deux totaux contradictoires
   * dans le même écran — le défaut que la page Rapports a déjà payé.
   */
  list(params: Record<string, string>): Observable<{ items: TripDto[]; nextCursor: string | null }> {
    return this.http.get<{ items: TripDto[]; nextCursor: string | null }>('/api/trips', { params });
  }

  findOne(id: string): Observable<TripDto> {
    return this.http.get<TripDto>(`/api/trips/${id}`);
  }

  /** Mêmes filtres que `list()`, `driverId` compris : ces chiffres alimentent les indicateurs. */
  dailySummary(params: Record<string, string>): Observable<TripDailySummaryDto[]> {
    return this.http.get<TripDailySummaryDto[]>('/api/trips/daily-summary', { params });
  }

  /**
   * Graphiques « Vitesses max » et « Fréquentation » sur la période ENTIÈRE.
   *
   * Distinct de `list()`, qui borne à 100 trajets pour le tableau : ces graphiques
   * prétendaient couvrir la période alors qu'ils dessinaient cet échantillon.
   *
   * Mêmes filtres que `list()`, `driverId` compris : des courbes décrivant toute la flotte à
   * côté d'un tableau filtré sur une personne auraient l'air justes.
   */
  periodCharts(params: Record<string, string>): Observable<TripPeriodChartsDto> {
    return this.http.get<TripPeriodChartsDto>('/api/trips/period-charts', { params });
  }

  recompute(data: { vehicleId: string; from: string; to: string }): Observable<TripRecomputeResultDto> {
    return this.http.post<TripRecomputeResultDto>('/api/trips/recompute', data);
  }

  /**
   * Met a jour la note libre d'un trajet. Passer null ou chaine vide efface
   * la note (et reset auteur cote backend). Retourne le trajet a jour avec
   * `notes`, `notesUpdatedAt` et `notesUpdatedBy` rafraichis.
   */
  updateNote(id: string, notes: string | null): Observable<TripDto> {
    return this.http.patch<TripDto>(`/api/trips/${id}/notes`, { notes });
  }
}
