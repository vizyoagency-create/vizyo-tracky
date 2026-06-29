import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AiCapacityApplyDto,
  AiCapacityResultDto,
  AiCapacitySuggestRequestDto,
  AiPlacementResultDto,
  AiPlacementSuggestRequestDto,
  FleetMetierDto,
  SetFleetMetierDto,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Sprint 9 — Copilote IA d'optimisation. Client HTTP typé sur les DTOs partagés.
 * Les `*Suggest` sont des DRY-RUN (aucune écriture serveur) ; l'application passe
 * par `capacityApply` (écrit le véhicule) ou le flux de réservation S8 (placement).
 * Sans ANTHROPIC_API_KEY côté serveur, les endpoints renvoient 503 (à gérer côté UI).
 */
@Injectable({ providedIn: 'root' })
export class AiApiService {
  private readonly http = inject(HttpClient);

  /** POST /api/ai/capacity/suggest — propositions places/places-enfant (DRY-RUN). */
  capacitySuggest(body: AiCapacitySuggestRequestDto = {}): Observable<AiCapacityResultDto> {
    return this.http.post<AiCapacityResultDto>('/api/ai/capacity/suggest', body);
  }

  /** POST /api/ai/capacity/apply — applique les propositions acceptées (écrit les véhicules). */
  capacityApply(body: AiCapacityApplyDto): Observable<{ updated: number }> {
    return this.http.post<{ updated: number }>('/api/ai/capacity/apply', body);
  }

  /** POST /api/ai/placement/suggest — classement raisonné parmi les disponibles (DRY-RUN). */
  placementSuggest(body: AiPlacementSuggestRequestDto): Observable<AiPlacementResultDto> {
    return this.http.post<AiPlacementResultDto>('/api/ai/placement/suggest', body);
  }

  /** GET /api/ai/fleet-metier — métier courant de la flotte. */
  getFleetMetier(fleetId?: string): Observable<FleetMetierDto> {
    return this.http.get<FleetMetierDto>('/api/ai/fleet-metier', {
      params: fleetId ? { fleetId } : {},
    });
  }

  /** PATCH /api/ai/fleet-metier — règle le métier de la flotte (admins). */
  setFleetMetier(body: SetFleetMetierDto): Observable<FleetMetierDto> {
    return this.http.patch<FleetMetierDto>('/api/ai/fleet-metier', body);
  }
}
