import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AgendaAgentProposalDto,
  AgendaAgentRunResultDto,
  AgendaAgentSettingsDto,
  SetAgendaAgentSettingsDto,
} from '@vizyo/tracky-shared';
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

  /** POST /api/agenda/agent/run — lance l'analyse maintenant (super/fleet admin). */
  run(fleetId?: string): Observable<AgendaAgentRunResultDto> {
    return this.http.post<AgendaAgentRunResultDto>('/api/agenda/agent/run', fleetId ? { fleetId } : {});
  }

  /** GET /api/agenda/agent/proposals — propositions de l'agent (défaut : en attente). */
  listProposals(fleetId?: string, status = 'pending'): Observable<AgendaAgentProposalDto[]> {
    const params: Record<string, string> = { status };
    if (fleetId) params['fleetId'] = fleetId;
    return this.http.get<AgendaAgentProposalDto[]>('/api/agenda/agent/proposals', { params });
  }

  /** POST /api/agenda/agent/proposals/:id/apply — valide (crée la réservation ferme). */
  applyProposal(id: string): Observable<AgendaAgentProposalDto> {
    return this.http.post<AgendaAgentProposalDto>(`/api/agenda/agent/proposals/${id}/apply`, {});
  }

  /** POST /api/agenda/agent/proposals/:id/dismiss — refuse la proposition. */
  dismissProposal(id: string): Observable<AgendaAgentProposalDto> {
    return this.http.post<AgendaAgentProposalDto>(`/api/agenda/agent/proposals/${id}/dismiss`, {});
  }
}
