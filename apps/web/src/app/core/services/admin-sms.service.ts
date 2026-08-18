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
  mode: 'vizyo-texto' | 'vizyo-texto-broken' | 'twilio' | 'twilio-broken' | 'noop';
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

// V1.15 — Resultat d'un heartbeat "preuve de vie" SMS (cron hebdo + run-now).
export interface SmsHeartbeatResult {
  provider: 'vizyo-texto' | 'twilio' | 'noop';
  recipients: number;
  sent: number;
  failed: number;
  skipped: boolean;
  results: { to: string; ok: boolean; error?: string }[];
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

export type ProvisioningStepStatus =
  | 'pending'
  | 'sent'
  | 'acked'
  | 'no-ack'
  | 'failed'
  | 'noop';

export interface ProvisioningStep {
  step: number;
  key: string;
  label: string;
  payload: string;
  status: ProvisioningStepStatus;
  sentAt?: string;
  twilioSid?: string;
  error?: string;
  reply?: string; // texte de la reponse du boitier
  repliedAt?: string;
  ackMatched?: boolean; // true si la reponse contient le mot-cle attendu
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
  // V1.18 — Etat LIVE du tracker (par imei). Permet d'afficher « Tracker connecté »
  // dès que le boîtier se reconnecte au serveur TCP, indépendamment des ACK SMS
  // (chaîne entrante fragile). `seenSinceStart` = vu en ligne après le lancement.
  tracker?: {
    status: 'ONLINE' | 'OFFLINE' | 'IDLE';
    lastSeenAt: string | null;
    lastPositionAt: string | null;
    seenSinceStart: boolean;
  } | null;
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

// V1.14 — Allowlist vizyo-texto
export interface AllowlistEntryDto {
  id: string;
  phone: string;
  label: string | null;
  source: string; // 'manual' | 'synced'
  createdAt: string;
}

export interface AllowlistSyncResult {
  added: number;
  removed: number;
  unchanged: number;
  skipped: number;
}

export interface AllowlistStatus {
  entries: AllowlistEntryDto[];
  total: number;
  trackersWithSim: number;
  missing: { imei: string; phone: string }[];
  orphans: { phone: string; label: string | null }[];
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

  /** V1.15 — Force un heartbeat "preuve de vie" SMS maintenant (sinon cron hebdo). */
  runHeartbeat() {
    return this.http.post<SmsHeartbeatResult>('/api/admin/sms/heartbeat/run-now', {});
  }

  /**
   * ⚠️ `startProvisioning` et `cancelProvisioning` ont ete retires ici (2026-08-18).
   *
   * Le lancement d'une configuration se fait desormais par
   * `POST /api/tracker-onboarding/provisionner`, ou l'APN, l'IP et le port sont DEDUITS
   * cote serveur au lieu d'etre saisis. Garder un client vers l'ancienne route laissait
   * un second chemin appelable, aux parametres libres — dont celui de l'IP du serveur.
   *
   * La route admin existe toujours cote API : elle n'est simplement plus atteignable
   * depuis l'application.
   */

  listProvisionings(limit = 50) {
    return this.http.get<{ items: ProvisioningDto[] }>('/api/admin/sms/provision', {
      params: { limit: String(limit) },
    });
  }

  getProvisioning(id: string) {
    return this.http.get<ProvisioningDto>(`/api/admin/sms/provision/${id}`);
  }

  backupHealth(limit = 30) {
    return this.http.get<BackupHealthResponse>('/api/admin/backup-health', {
      params: { limit: String(limit) },
    });
  }

  // ─── Allowlist vizyo-texto (V1.14) ────────────────────────────────────────

  allowlist() {
    return this.http.get<AllowlistEntryDto[]>('/api/admin/sms/allowlist');
  }

  allowlistStatus() {
    return this.http.get<AllowlistStatus>('/api/admin/sms/allowlist/status');
  }

  addAllowlist(phone: string, label?: string) {
    return this.http.post<AllowlistEntryDto>('/api/admin/sms/allowlist', { phone, label });
  }

  removeAllowlist(phone: string) {
    return this.http.delete<{ removed: boolean }>(
      `/api/admin/sms/allowlist/${encodeURIComponent(phone)}`,
    );
  }

  syncAllowlist() {
    return this.http.post<AllowlistSyncResult>('/api/admin/sms/allowlist/sync', {});
  }

  /** V1.14 — Renseigne la SIM d'un tracker (PATCH /api/trackers/:id). */
  setTrackerSim(trackerId: string, simPhoneNumber: string) {
    return this.http.patch(`/api/trackers/${trackerId}`, { simPhoneNumber });
  }
}
