import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface TrackerDetail {
  id: string;
  imei: string;
  model: string;
  status: string;
  lastSeenAt: string | null;
  vehicleId: string | null;
  vehicle: { id: string; plate: string; fleetId: string; fleet?: { id: string; name: string }; group?: { id: string; name: string } | null } | null;
  /** V1.7 — fil ACC connecte (true) ou ignition inferee depuis vitesse (false). */
  accConnected: boolean;
  /** V1.14 — numero SIM data (E.164) pour fallback SMS + allowlist vizyo-texto. */
  simPhoneNumber: string | null;
  /**
   * 2026-09-30 — le boîtier est-il encore au mot de passe d'usine ?
   *
   * Toute commande SMS Coban le porte (`stop<mdp>`, `resume<mdp>`) : tant qu'il vaut la valeur
   * d'usine, quiconque connaît le numéro de SIM peut immobiliser le véhicule sans passer par
   * Tracky, sans trace et sans droit. C'est arrivé le 24/09/2026 chez CDEF31.
   *
   * ⚠️ L'API ne sert PAS le mot de passe lui-même par cette route — seulement ce booléen. Le
   * secret n'est lu qu'au moment de construire un SMS, côté serveur.
   */
  motDePasseUsine?: boolean;
  // V2 — champs détaillés (page détail tracker), renvoyés par GET /trackers/:id.
  lastLat?: number | null;
  lastLng?: number | null;
  lastSpeedKmh?: number | null;
  lastIgnition?: boolean | null;
  lastPositionAt?: string | null;
  createdAt?: string | null;
}

export interface UpdateTrackerPayload {
  model?: string;
  /** V1.7 — toggle SUPER_ADMIN. Backend rejette en 403 pour les autres roles. */
  accConnected?: boolean;
  /** V1.14 — numero SIM (E.164) ou '' pour effacer. */
  simPhoneNumber?: string;
}

@Injectable({ providedIn: 'root' })
export class TrackersApiService {
  private readonly http = inject(HttpClient);

  create(data: { imei: string; model?: string; simPhoneNumber?: string }): Observable<TrackerDetail> {
    return this.http.post<TrackerDetail>('/api/trackers', data);
  }

  assign(trackerId: string, vehicleId: string): Observable<TrackerDetail> {
    return this.http.post<TrackerDetail>(`/api/trackers/${trackerId}/assign`, { vehicleId });
  }

  unassign(trackerId: string): Observable<TrackerDetail> {
    return this.http.post<TrackerDetail>(`/api/trackers/${trackerId}/unassign`, {});
  }

  list(params?: Record<string, string>): Observable<TrackerDetail[]> {
    return this.http.get<TrackerDetail[]>('/api/trackers', { params });
  }

  findOne(id: string): Observable<TrackerDetail> {
    return this.http.get<TrackerDetail>(`/api/trackers/${id}`);
  }

  /** V1.7 — update partiel (model + accConnected). accConnected = SUPER_ADMIN only. */
  update(id: string, payload: UpdateTrackerPayload): Observable<TrackerDetail> {
    return this.http.patch<TrackerDetail>(`/api/trackers/${id}`, payload);
  }
}
