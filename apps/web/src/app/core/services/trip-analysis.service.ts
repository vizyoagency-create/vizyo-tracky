import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { TripAnalysisDto } from '@vizyo/tracky-shared';
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
}
