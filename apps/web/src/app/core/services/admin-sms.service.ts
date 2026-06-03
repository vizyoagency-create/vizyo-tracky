import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';

/**
 * V1.13 — Verdict reel SMS Gateway. Etend l'ancien `{ enabled, mode }`.
 *   - 'twilio'         : env vars set + auth Twilio OK (reachable)
 *   - 'twilio-broken'  : env vars set MAIS auth Twilio echoue (credentials KO)
 *   - 'noop'           : env vars manquants (dev mode)
 * Backward compat : l'UI doit privilegier `reachable` au lieu de `enabled`
 * pour le badge visuel ; sinon "Twilio actif" peut mentir.
 */
export interface SmsStatus {
  enabled: boolean;
  reachable?: boolean;
  mode: 'twilio' | 'twilio-broken' | 'noop';
  error?: string;
  errorCode?: string;
  fromNumber?: string;
  recentFailures24h?: number;
  lastFailure?: {
    at: string;
    toNumber: string | null;
    errorCode?: string;
    errorMessage?: string;
  } | null;
}

export interface SmsTestFallbackResult {
  ok: boolean;
  payload: string;
  trackerImei: string;
  smsResult: { ok: boolean; twilioSid?: string; error?: string };
}

export interface SmsLogDto {
  id: string;
  direction: 'OUT' | 'IN';
  fromNumber: string | null;
  toNumber: string | null;
  body: string;
  twilioSid: string | null;
  status: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  imei: string | null;
  provisioningId: string | null;
  createdAt: string;
}

export interface ProvisioningStep {
  step: number;
  payload: string;
  sentAt: string;
  status: 'sent' | 'failed' | 'noop';
  twilioSid?: string;
  error?: string;
}

export interface ProvisioningDto {
  id: string;
  imei: string;
  phoneNumber: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  currentStep: number;
  apn: string | null;
  apnUser: string | null;
  apnPasswd: string | null;
  serverIp: string | null;
  serverPort: number | null;
  lowBatteryPhone: string | null;
  steps: ProvisioningStep[];
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface BackupHealthItem {
  id: string;
  status: 'OK' | 'FAILED';
  sizeBytes: string | null;
  durationMs: number | null;
  destination: string | null;
  filename: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface BackupHealthResponse {
  items: BackupHealthItem[];
  lastSuccess: { id: string; createdAt: string; ageHours: number } | null;
  stale: boolean;
}

@Injectable({ providedIn: 'root' })
export class AdminSmsService {
  private readonly http = inject(HttpClient);

  status() {
    return this.http.get<SmsStatus>('/api/admin/sms/status');
  }

  logs(limit = 100, imei?: string) {
    const params: Record<string, string> = { limit: String(limit) };
    if (imei) params['imei'] = imei;
    return this.http.get<{ items: SmsLogDto[] }>('/api/admin/sms/logs', { params });
  }

  send(to: string, message: string) {
    return this.http.post<{ ok: boolean; twilioSid?: string; error?: string }>(
      '/api/admin/sms/send',
      { to, message },
    );
  }

  /** V1.13 — Test du flow fallback SMS bypass conditions (cf backend). */
  testFallback(trackerId: string, recipientPhone: string) {
    return this.http.post<SmsTestFallbackResult>(
      '/api/admin/sms/test-fallback',
      { trackerId, recipientPhone },
    );
  }

  startProvisioning(body: {
    imei: string;
    phoneNumber: string;
    apn: string;
    apnUser?: string;
    apnPasswd?: string;
    serverIp: string;
    serverPort: number;
    lowBatteryPhone?: string;
  }) {
    return this.http.post<{ id: string }>('/api/admin/sms/provision', body);
  }

  listProvisionings(limit = 50) {
    return this.http.get<{ items: ProvisioningDto[] }>('/api/admin/sms/provision', {
      params: { limit: String(limit) },
    });
  }

  getProvisioning(id: string) {
    return this.http.get<ProvisioningDto>(`/api/admin/sms/provision/${id}`);
  }

  cancelProvisioning(id: string) {
    return this.http.post<{ ok: boolean }>(`/api/admin/sms/provision/${id}/cancel`, {});
  }

  backupHealth(limit = 30) {
    return this.http.get<BackupHealthResponse>('/api/admin/backup-health', {
      params: { limit: String(limit) },
    });
  }
}
