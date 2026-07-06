import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { PrivacyModeEventDto, PrivacyModeStateDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Mode vie privée conducteur (par véhicule) — client HTTP. Sous-ressource de
 * /api/vehicles/:vehicleId/privacy-mode. Gate serveur : permission `privacy_manage`.
 */
@Injectable({ providedIn: 'root' })
export class PrivacyModeApiService {
  private readonly http = inject(HttpClient);

  set(vehicleId: string, enabled: boolean, reason?: string): Observable<PrivacyModeStateDto> {
    return this.http.post<PrivacyModeStateDto>(`/api/vehicles/${vehicleId}/privacy-mode`, { enabled, reason: reason ?? null });
  }

  getState(vehicleId: string): Observable<PrivacyModeStateDto> {
    return this.http.get<PrivacyModeStateDto>(`/api/vehicles/${vehicleId}/privacy-mode`);
  }

  getHistory(vehicleId: string, limit = 30): Observable<PrivacyModeEventDto[]> {
    return this.http.get<PrivacyModeEventDto[]>(`/api/vehicles/${vehicleId}/privacy-mode/history`, { params: { limit: String(limit) } });
  }
}
