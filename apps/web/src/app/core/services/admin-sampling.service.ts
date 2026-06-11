import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';

export type SamplingState = 'MOVING' | 'IDLE_ENGINE_ON' | 'STOPPED';
export type SamplingDecision =
  | 'INSERTED'
  | 'INSERTED_VERBOSE'
  | 'SKIPPED_DUP'
  | 'SKIPPED_THROTTLE'
  // Trame rejouee/aberrante rejetee par le garde-fou d'ingestion (anti-replay).
  | 'SKIPPED_REPLAY';

export interface SamplingStatsDto {
  rangeHours: number;
  received: number;
  inserted: number;
  skipped: number;
  insertRatio: number;
  byState: { state: SamplingState; inserted: number; skipped: number }[];
  byDecision: { decision: SamplingDecision; count: number }[];
}

export interface SamplingHistogramBucket {
  hour: string;
  inserted: number;
  skipped: number;
}

export interface SamplingDecisionDto {
  id: string;
  decision: SamplingDecision;
  state: SamplingState;
  reason: string | null;
  speedKmh: number | null;
  ignition: boolean | null;
  distanceM: number | null;
  receivedAt: string;
}

@Injectable({ providedIn: 'root' })
export class AdminSamplingService {
  private readonly http = inject(HttpClient);

  stats(trackerId: string, rangeHours = 24) {
    return this.http.get<SamplingStatsDto>(
      `/api/admin/trackers/${trackerId}/sampling/stats`,
      { params: { rangeHours: String(rangeHours) } },
    );
  }

  histogram(trackerId: string, days = 7) {
    return this.http.get<{ days: number; buckets: SamplingHistogramBucket[] }>(
      `/api/admin/trackers/${trackerId}/sampling/histogram`,
      { params: { days: String(days) } },
    );
  }

  recent(trackerId: string, limit = 50) {
    return this.http.get<{ items: SamplingDecisionDto[] }>(
      `/api/admin/trackers/${trackerId}/sampling/recent`,
      { params: { limit: String(limit) } },
    );
  }

  toggleVerbose(trackerId: string, durationMinutes: number) {
    return this.http.post<{ verboseUntil: string | null }>(
      `/api/admin/trackers/${trackerId}/sampling/verbose`,
      { durationMinutes },
    );
  }
}
