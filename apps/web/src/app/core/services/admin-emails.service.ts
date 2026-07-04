import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';

/** Statut d'un e-mail (miroir de l'enum Prisma EmailStatus). */
export type EmailStatus =
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'OPENED'
  | 'CLICKED'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'FAILED';

export interface EmailStats {
  sent: number;
  deliveredRate: number;
  openRate: number;
  failed24h: number;
  suppressed: number;
  series: { day: string; delivered: number; failed: number }[];
  byTemplate: { template: string; label: string; count: number }[];
}

export interface EmailLogDto {
  id: string;
  providerId: string | null;
  template: string;
  toAddress: string;
  subject: string;
  status: EmailStatus;
  fleetId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  openedAt: string | null;
  createdAt: string;
}

export interface EmailLogsPage {
  items: EmailLogDto[];
  nextCursor?: string;
}

export interface EmailTemplateMeta {
  id: string;
  label: string;
  category: string;
  subject: string;
  trigger: string;
  sent30d: number;
  openRate: number | null; // null = pas de tracking (e-mail de sécurité) → « — »
  lastSentAt: string | null;
}

export interface Deliverability {
  domain: string;
  verified: boolean;
  spf: 'pass' | 'fail';
  dkim: 'pass' | 'fail';
  dmarc: 'pass' | 'warn' | 'fail';
  bounceReasons: { code: string; label: string; desc: string; count: number }[];
  suppression: { email: string; reason: string; date: string }[];
}

export interface EmailLogsQuery {
  status?: string;
  template?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Centre de gestion des e-mails (admin, SUPER_ADMIN). Calque AdminSmsService :
 * un @Injectable({providedIn:'root'}), une interface par réponse, une méthode par
 * endpoint `/api/admin/emails/*`.
 */
@Injectable({ providedIn: 'root' })
export class AdminEmailsService {
  private readonly http = inject(HttpClient);

  stats(range: '7d' | '30d' | '90d' = '30d') {
    return this.http.get<EmailStats>('/api/admin/emails/stats', { params: { range } });
  }

  logs(query: EmailLogsQuery = {}) {
    const params: Record<string, string> = {};
    if (query.status) params['status'] = query.status;
    if (query.template) params['template'] = query.template;
    if (query.q) params['q'] = query.q;
    if (query.cursor) params['cursor'] = query.cursor;
    params['limit'] = String(query.limit ?? 50);
    return this.http.get<EmailLogsPage>('/api/admin/emails/logs', { params });
  }

  templates() {
    return this.http.get<EmailTemplateMeta[]>('/api/admin/emails/templates');
  }

  deliverability() {
    return this.http.get<Deliverability>('/api/admin/emails/deliverability');
  }

  preview(id: string) {
    return this.http.get<{ subject: string; html: string }>(
      `/api/admin/emails/templates/${encodeURIComponent(id)}/preview`,
    );
  }

  sendTest(id: string, to: string) {
    return this.http.post<{ ok: boolean; error?: string }>(
      `/api/admin/emails/templates/${encodeURIComponent(id)}/test`,
      { to },
    );
  }
}
