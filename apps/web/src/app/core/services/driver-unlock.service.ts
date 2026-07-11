import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface DriverUnlockResultDto {
  ok: boolean;
  vehicleId: string;
  plate: string;
  distanceM: number;
  message: string;
  /** Incr.5 — le conducteur peut-il gérer le mode vie privée de ce véhicule (droit accordé) ? */
  canManagePrivacy: boolean;
  /** État courant du mode vie privée du véhicule. */
  privacyModeEnabled: boolean;
}

/** feat/comptes-conducteurs (4b/5) — déverrouillage conducteur (QR + proximité) + mode vie privée. */
@Injectable({ providedIn: 'root' })
export class DriverUnlockApiService {
  private readonly http = inject(HttpClient);

  unlock(body: {
    token?: string;
    vehicleId?: string;
    lat: number;
    lng: number;
    accuracy?: number;
  }): Observable<DriverUnlockResultDto> {
    return this.http.post<DriverUnlockResultDto>('/api/driver/unlock', body);
  }

  /** Incr.5 — le conducteur (ré)active le mode vie privée de SON véhicule (si autorisé). */
  setPrivacy(vehicleId: string, enabled: boolean): Observable<unknown> {
    return this.http.post(`/api/vehicles/${vehicleId}/privacy-mode`, { enabled });
  }
}
