import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface EngineControlCommandDto {
  id: string;
  trackerId: string;
  action: 'CUT' | 'RESTORE';
  /** TRK-018 — `SENT_UNCONFIRMED` : partie, echeance passee, NUL NE SAIT si elle a abouti. */
  status: 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'FAILED' | 'REJECTED_SPEED' | 'SENT_UNCONFIRMED';
  reason: string | null;
  source: 'MANUAL' | 'SCHEDULER' | 'DEVICE_OBSERVED';
  lastError: string | null;
  requestedBy: string;
  createdAt: string;
  sentAt: string | null;
  /** Sprint 2 — true si une chute d'ignition est attendable comme preuve (CUT en marche). */
  confirmationExpected?: boolean;
  ackedAt?: string | null;
}

@Injectable({ providedIn: 'root' })
export class EngineControlService {
  private readonly http = inject(HttpClient);

  requestCommand(
    trackerId: string,
    action: 'CUT' | 'RESTORE',
    reason?: string,
    disableSchedule?: boolean,
  ): Observable<EngineControlCommandDto> {
    return this.http.post<EngineControlCommandDto>(
      `/api/engine-control/trackers/${trackerId}/commands`,
      { action, reason, ...(disableSchedule ? { disableSchedule: true } : {}) },
    );
  }

  listCommands(trackerId: string, limit = 5): Observable<EngineControlCommandDto[]> {
    return this.http.get<EngineControlCommandDto[]>(
      '/api/engine-control/commands',
      { params: { trackerId, limit: String(limit) } },
    );
  }
}
