import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export interface EngineControlCommandDto {
  id: string;
  trackerId: string;
  action: 'CUT' | 'RESTORE';
  status: 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'FAILED' | 'REJECTED_SPEED';
  reason: string | null;
  source: 'MANUAL' | 'SCHEDULER' | 'DEVICE_OBSERVED';
  lastError: string | null;
  requestedBy: string;
  createdAt: string;
  sentAt: string | null;
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
