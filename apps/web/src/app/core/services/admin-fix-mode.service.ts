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
  /** Vue courante du centre d'alerte : actives (defaut), archivees, ou toutes. */
  vueArchivage: 'actives' | 'archivees' | 'toutes';
  /** Lignes archivees sur 24 h — sans ce chiffre, un ecran vide est ambigu. */
  errorsArchivees24h: number;
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
  userId: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
  /** Non nul = archivee : hors de la vue par defaut, mais TOUJOURS en base. */
  resolvedAt: string | null;
  resolvedById: string | null;
  resolvedNote: string | null;
}

export interface ErrorAlertsSummary {
  last24h: number;
  criticalLastHour: number;
  bySource: ErrorSourceGroup[];
  topMessages: ErrorTopMessage[];
  recentCritical: ErrorCriticalEntry[];
  /** Dernières erreurs toutes catégories (avec contexte user/page/device). */
  recent: ErrorCriticalEntry[];
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

  alerts(fleetId?: string, since?: string, archivees?: 'actives' | 'archivees' | 'toutes') {
    const params: Record<string, string> = {};
    if (fleetId) params['fleetId'] = fleetId;
    if (since) params['since'] = since;
    if (archivees && archivees !== 'actives') params['archivees'] = archivees === 'toutes' ? 'toutes' : 'true';
    return this.http.get<AdminAlertsDto>('/api/admin/alerts', { params });
  }

  /**
   * ARCHIVAGE — « clear » ne supprime rien : la ligne sort de la vue par defaut et
   * se rouvre. Voir TRK-035 : une ligne effacee est une connaissance perdue.
   */
  archiverErreur(id: string, note?: string) {
    return this.http.post<{ ok: boolean; dejaArchivee?: boolean }>(
      `/api/admin/alerts/errors/${id}/archiver`, { note },
    );
  }

  rouvrirErreur(id: string) {
    return this.http.post<{ ok: boolean; dejaActive?: boolean }>(
      `/api/admin/alerts/errors/${id}/rouvrir`, {},
    );
  }

  /**
   * Le geste de fin de journee. `avant` porte l'instant ou l'ecran a ete LU : sans
   * lui, une erreur arrivee entre l'affichage et le clic serait archivee sans avoir
   * ete vue.
   */
  archiverEnMasse(avant: string, note?: string) {
    return this.http.post<{ ok: boolean; archivees: number }>(
      '/api/admin/alerts/errors/archiver-en-masse', { avant, note },
    );
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
