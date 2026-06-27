import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { AudioCommandAuditDto, FleetAudioConfigDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Sprint 4 — Écoute audio à distance (micro embarqué). LÉGALEMENT CRITIQUE.
 *
 * Scénario A (appel live) : déclencher l'« écoute » ARME le micro du boîtier et renvoie
 * le n° SIM que l'admin doit APPELER pour entendre la cabine. AUCUN audio n'est joué/
 * stocké côté app : ce client porte uniquement le déclenchement (gate + motif), l'état
 * d'activation flotte et l'audit.
 */
export interface ListenResult {
  /** La commande d'audit créée côté serveur (status PENDING→SENT, motif, qui/quand). */
  command: AudioCommandAuditDto | { id: string; status: string };
  /** Le n° SIM du boîtier à APPELER pour écouter la cabine. null = SIM non provisionnée. */
  simPhoneNumber: string | null;
}

@Injectable({ providedIn: 'root' })
export class AudioMonitoringService {
  private readonly http = inject(HttpClient);

  /**
   * Déclenche une écoute (Scénario A : arme le micro). Le motif est OBLIGATOIRE (le
   * serveur refuse un motif vide). Retourne le n° SIM à appeler.
   */
  listen(trackerId: string, reason: string): Observable<ListenResult> {
    return this.http.post<ListenResult>(
      `/api/audio-monitoring/trackers/${trackerId}/listen`,
      { reason },
    );
  }

  /** État d'activation de l'écoute pour une flotte (écran d'activation). */
  getFleetAudioConfig(fleetId: string): Observable<FleetAudioConfigDto> {
    return this.http.get<FleetAudioConfigDto>(
      `/api/audio-monitoring/fleets/${fleetId}/config`,
    );
  }

  /**
   * Active / désactive l'écoute pour une flotte. Activer EXIGE l'attestation ; à
   * l'activation un mail OBLIGATIONS part à tous les utilisateurs de la flotte.
   */
  setFleetAudioConfig(
    fleetId: string,
    dto: { enabled: boolean; attestation?: boolean; attestationVersion?: string },
  ): Observable<FleetAudioConfigDto> {
    return this.http.patch<FleetAudioConfigDto>(
      `/api/audio-monitoring/fleets/${fleetId}/config`,
      dto,
    );
  }

  /** Audit des écoutes (qui/quand/véhicule/motif/env) — vue admin paginée (cursor `before`). */
  getAudit(filters: {
    limit?: number;
    before?: string;
    status?: string;
  } = {}): Observable<AudioCommandAuditDto[]> {
    let params = new HttpParams().set('limit', String(filters.limit ?? 50));
    if (filters.before) params = params.set('before', filters.before);
    if (filters.status) params = params.set('status', filters.status);
    return this.http.get<AudioCommandAuditDto[]>('/api/audio-monitoring/audit', { params });
  }
}
