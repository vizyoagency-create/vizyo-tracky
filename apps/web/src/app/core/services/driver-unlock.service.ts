import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface DriverUnlockResultDto {
  ok: boolean;
  vehicleId: string;
  plate: string;
  distanceM: number;
  message: string;
}

/** feat/comptes-conducteurs (4b) — appel de déverrouillage conducteur (QR + proximité). */
@Injectable({ providedIn: 'root' })
export class DriverUnlockApiService {
  private readonly http = inject(HttpClient);

  unlock(body: { token: string; lat: number; lng: number; accuracy?: number }): Observable<DriverUnlockResultDto> {
    return this.http.post<DriverUnlockResultDto>('/api/driver/unlock', body);
  }
}
