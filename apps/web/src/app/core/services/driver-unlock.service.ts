import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/** Réponse minimale : le conducteur ne reçoit qu'une confirmation, aucune donnée flotte. */
export interface DriverUnlockResultDto {
  ok: boolean;
  message: string;
}

/** feat/comptes-conducteurs (4b) — déverrouillage conducteur (QR/in-app + proximité), unlock-only. */
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
}
