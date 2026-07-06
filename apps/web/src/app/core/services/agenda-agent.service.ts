import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { AgendaAgentSettingsDto, SetAgendaAgentSettingsDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Refonte agenda/IA (2026-07) — Client HTTP des réglages de l'agent d'optimisation d'agenda
 * (⚙️ « Paramètres de l'agenda », PAR FLOTTE). SUPER_ADMIN (via fleetId) + FLEET_ADMIN (scopé serveur).
 */
@Injectable({ providedIn: 'root' })
export class AgendaAgentApiService {
  private readonly http = inject(HttpClient);

  /** GET /api/agenda/agent-settings — réglages courants (défauts si jamais configurés). */
  getSettings(fleetId?: string): Observable<AgendaAgentSettingsDto> {
    return this.http.get<AgendaAgentSettingsDto>('/api/agenda/agent-settings', {
      params: fleetId ? { fleetId } : {},
    });
  }

  /** PUT /api/agenda/agent-settings — met à jour (partiel) les réglages. */
  setSettings(body: SetAgendaAgentSettingsDto): Observable<AgendaAgentSettingsDto> {
    return this.http.put<AgendaAgentSettingsDto>('/api/agenda/agent-settings', body);
  }
}
