import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';

export interface AdminAlertSummary {
  failing: number;
  offline: number;
  pending: number;
  errorsLast24h: number;
  errorsPrev24h: number;
  criticalLastHour: number;
  errorsSinceLastVisit: number | null;
}

export interface ErrorSourceGroup {
  source: string;
  count: number;
  lastAt: string;
}

export interface ErrorTopMessage {
  message: string;
  source: string;
  count: number;
  level: string;
  lastAt: string;
  lastId: string;
}

export interface ErrorCriticalEntry {
  id: string;
  level: string;
  source: string;
  message: string;
  stack: string | null;
  imei: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
}

export interface ErrorAlertsSummary {
  last24h: number;
  criticalLastHour: number;
  bySource: ErrorSourceGroup[];
  topMessages: ErrorTopMessage[];
  recentCritical: ErrorCriticalEntry[];
}

export interface FailingTrackerAlert {
  kind: 'TRACKER_FAILING';
  trackerId: string;
  imei: string;
  vehicleId: string | null;
  plate: string | null;
  fleetId: string | null;
  fleetName: string | null;
  fixCommandFailureCount: number;
  desiredFixIntervalS: number;
  currentFixIntervalS: number | null;
  lastSeenAt: string | null;
  lastFixIntervalSyncAt: string | null;
}

export interface OfflineTrackerAlert {
  kind: 'TRACKER_OFFLINE';
  trackerId: string;
  imei: string;
  vehicleId: string | null;
  plate: string | null;
  fleetId: string | null;
  fleetName: string | null;
  lastSeenAt: string | null;
  offlineSinceMs: number | null;
}

export interface PendingCommandAlert {
  kind: 'COMMAND_PENDING';
  commandId: string;
  trackerId: string;
  imei: string;
  vehicleId: string | null;
  plate: string | null;
  fleetId: string | null;
  fleetName: string | null;
  category: string;
  templateId: string;
  status: string;
  sentAt: string | null;
  createdAt: string;
  diagnosticHint: string | null;
  outcomeReason: string | null;
}

export interface AdminAlertsDto {
  summary: AdminAlertSummary;
  failing: FailingTrackerAlert[];
  offline: OfflineTrackerAlert[];
  pendingCommands: PendingCommandAlert[];
  errors: ErrorAlertsSummary;
}

export interface ErrorTimelineBucket {
  hour: string;
  error: number;
  critical: number;
}

export interface ErrorExport {
  markdown: string;
  errorCount: number;
  criticalCount: number;
  window: string;
}

export interface FixModeStateDto {
  trackerId: string;
  imei: string;
  vehiclePlate: string | null;
  desiredFixIntervalS: number;
  currentFixIntervalS: number | null;
  lastFixIntervalSyncAt: string | null;
  lastValidFrameAt: string | null;
  lastSeenAt: string | null;
  status: 'ONLINE' | 'OFFLINE' | 'IDLE';
  fixCommandFailureCount: number;
  fixCommandFailing: boolean;
  fixModeOverrideUntil: string | null;
  lastSampledState: string | null;
  adaptiveFixModeEnabled: boolean;
}

export interface FixModeTimelineEntry {
  id: string;
  templateId: string;
  params: Record<string, unknown>;
  payload: string;
  channel: string;
  status: string;
  outcomeReason: string | null;
  expectedResult: string | null;
  observedResult: string | null;
  diagnosticHint: string | null;
  contextSnapshot: Record<string, unknown> | null;
  lastError: string | null;
  sentAt: string | null;
  ackedAt: string | null;
  ackResponse: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class AdminFixModeService {
  private readonly http = inject(HttpClient);

  alerts(fleetId?: string, since?: string) {
    const params: Record<string, string> = {};
    if (fleetId) params['fleetId'] = fleetId;
    if (since) params['since'] = since;
    return this.http.get<AdminAlertsDto>('/api/admin/alerts', { params });
  }

  acknowledgeCommand(commandId: string, note?: string) {
    return this.http.post<unknown>(`/api/admin/alerts/commands/${commandId}/acknowledge`, { note });
  }

  clearFailing(trackerId: string) {
    return this.http.post<{ ok: boolean }>(
      `/api/admin/alerts/trackers/${trackerId}/clear-failing`,
      {},
    );
  }

  state(trackerId: string) {
    return this.http.get<FixModeStateDto>(`/api/admin/trackers/${trackerId}/fix-mode/state`);
  }

  timeline(trackerId: string, days = 90, outcome?: 'failed' | 'pending') {
    const params: Record<string, string> = { days: String(days) };
    if (outcome) params['outcome'] = outcome;
    return this.http.get<{ days: number; items: FixModeTimelineEntry[] }>(
      `/api/admin/trackers/${trackerId}/fix-mode/timeline`,
      { params },
    );
  }

  setOverride(trackerId: string, durationMinutes: number, intervalS: number | null) {
    return this.http.post<{ overrideUntil: string | null; commandId: string | null }>(
      `/api/admin/trackers/${trackerId}/fix-mode/override`,
      { durationMinutes, intervalS },
    );
  }

  errorsTimeline() {
    return this.http.get<{ buckets: ErrorTimelineBucket[] }>('/api/admin/alerts/errors/timeline');
  }

  errorsExport() {
    return this.http.get<ErrorExport>('/api/admin/alerts/errors/export');
  }
}
