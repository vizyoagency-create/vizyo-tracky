import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AudioCommandAuditDto,
  FleetAudioConfigDto,
  FleetAudioEligibilityDto,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Sprint 4 — Écoute audio à distance (micro embarqué). LÉGALEMENT CRITIQUE.
 *
 * Scénario A (appel live) : déclencher l'« écoute » ARME le micro du boîtier et renvoie
 * le n° SIM que l'admin doit APPELER pour entendre la cabine. AUCUN audio n'est joué/
 * stocké côté app : ce client porte uniquement le déclenchement (gate + motif), le
 * gating flotte à DEUX étages et l'audit.
 *
 * Gating à deux étages :
 *  - N1 « éligibilité » (super-admin/prestataire) : `superAdminEnabled`. La flotte
 *    est-elle AUTORISÉE au Mode assistance ? → getFleetsWithAudio / setFleetEligibility.
 *  - N2 « Mode assistance » (fleet-admin/client) : `assistanceEnabled`. Consentement
 *    du client, possible uniquement si éligible → setFleetAssistanceMode.
 *  L'écoute n'est permise que si les DEUX sont true.
 */
export interface ListenResult {
  /** La commande d'audit créée côté serveur (status PENDING→SENT, motif, qui/quand). */
  command: AudioCommandAuditDto | { id: string; status: string };
  /** Le n° SIM du boîtier à APPELER pour écouter la cabine. null = SIM non provisionnée. */
  simPhoneNumber: string | null;
}

/** Résultat du désarmement (retour mode track). `ok` = SMS `tracker<pwd>` accepté. */
export interface StopResult {
  ok: boolean;
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

  /**
   * DÉSARME le micro (retour mode « track »). CRITIQUE : le mode monitor coupe le report
   * GPS, donc terminer l'écoute remet le véhicule visible sur la carte. Le serveur envoie
   * `tracker<password>` à la SIM du boîtier (super-admin only, mêmes gates que `listen`).
   */
  stopListen(trackerId: string): Observable<StopResult> {
    return this.http.post<StopResult>(
      `/api/audio-monitoring/trackers/${trackerId}/stop`,
      {},
    );
  }

  /**
   * État d'activation de l'écoute pour une flotte — porte les DEUX étages
   * (`superAdminEnabled` éligibilité N1, `assistanceEnabled` Mode assistance N2).
   */
  getFleetAudioConfig(fleetId: string): Observable<FleetAudioConfigDto> {
    return this.http.get<FleetAudioConfigDto>(
      `/api/audio-monitoring/fleets/${fleetId}/config`,
    );
  }

  /**
   * N2 — CONSENTEMENT « Mode assistance » du fleet-admin (client). Activer EXIGE
   * l'attestation. Refusé par le serveur si la flotte n'est pas éligible (N1). À
   * l'activation un mail OBLIGATIONS part à tous les utilisateurs de la flotte.
   */
  setFleetAssistanceMode(
    fleetId: string,
    dto: {
      assistanceEnabled: boolean;
      attestation?: boolean;
      attestationVersion?: string;
    },
  ): Observable<FleetAudioConfigDto> {
    return this.http.patch<FleetAudioConfigDto>(
      `/api/audio-monitoring/fleets/${fleetId}/config`,
      dto,
    );
  }

  /**
   * N1 (vue) — éligibilité audio de TOUTES les flottes (super-admin/prestataire).
   * Chaque ligne porte l'état des deux étages (éligibilité N1 + consentement N2).
   */
  getFleetsWithAudio(): Observable<FleetAudioEligibilityDto[]> {
    return this.http.get<FleetAudioEligibilityDto[]>('/api/audio-monitoring/fleets');
  }

  /**
   * N1 (action) — rend une flotte ÉLIGIBLE (ou non) au Mode assistance. `eligible:false`
   * cascade « tout OFF » côté serveur (le consentement N2 du client est aussi remis à off).
   */
  setFleetEligibility(
    fleetId: string,
    eligible: boolean,
  ): Observable<FleetAudioConfigDto> {
    return this.http.patch<FleetAudioConfigDto>(
      `/api/audio-monitoring/fleets/${fleetId}/eligibility`,
      { eligible },
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
