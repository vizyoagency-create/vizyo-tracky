import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { EnvoisSocieteDto } from '@vizyo/tracky-shared';

export interface FleetSummary {
  id: string;
  name: string;
}

@Injectable({ providedIn: 'root' })
export class FleetsApiService {
  private readonly http = inject(HttpClient);

  list(): Observable<FleetSummary[]> {
    return this.http.get<FleetSummary[]>('/api/fleets');
  }

  /** 30/09 — le mode recette de la société (garde-fou d'envoi) : jusqu'à quand ses avis sont retenus. */
  envois(fleetId: string): Observable<EnvoisSocieteDto> {
    return this.http.get<EnvoisSocieteDto>(`/api/fleets/${encodeURIComponent(fleetId)}/envois`);
  }

  /** Super-admin : retenir les avis de la société `heures` (1 à 24), ou les rétablir (`null`). */
  reglerEnvois(fleetId: string, heures: number | null): Observable<EnvoisSocieteDto> {
    return this.http.put<EnvoisSocieteDto>(`/api/fleets/${encodeURIComponent(fleetId)}/envois`, { heures });
  }
}
