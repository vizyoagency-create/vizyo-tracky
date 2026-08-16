import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';

export type CommChannel = 'EMAIL' | 'SMS' | 'PUSH';
export type CommOutcome = 'DELIVERED' | 'SENT' | 'FAILED' | 'EXPIRED' | 'RECEIVED';

export interface CommChannelKpi {
  channel: CommChannel;
  sent: number;
  delivered: number;
  failed: number;
  successRate: number;
  lastAt: string | null;
}

export interface CommOverview {
  days: number;
  totalSent: number;
  channels: CommChannelKpi[];
  byTemplate: { channel: CommChannel; template: string; label: string; count: number }[];
  series: { day: string; ok: number; failed: number }[];
}

export interface CommLogDto {
  id: string;
  channel: CommChannel;
  template: string | null;
  templateLabel: string;
  target: string;
  subject: string;
  status: string;
  outcome: CommOutcome;
  error: string | null;
  createdAt: string;
}

export interface CommTemplateDto {
  channel: CommChannel;
  id: string;
  label: string;
  category: string;
  trigger: string;
  description: string;
  noOpenTracking?: boolean;
  sent30d: number;
  failed30d: number;
  lastSentAt: string | null;
  previewable: boolean;
}

export interface CommLogsQuery {
  channel?: CommChannel;
  template?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

/**
 * Module Communications (admin, SUPER_ADMIN) — e-mails + SMS + notifications réunis
 * derrière `/api/admin/communications/*`. L'aperçu et l'envoi de test restent servis
 * par AdminEmailsService (spécifiques au rendu HTML e-mail).
 */
@Injectable({ providedIn: 'root' })
export class AdminCommunicationsService {
  private readonly http = inject(HttpClient);

  overview(range: '7d' | '30d' | '90d' = '30d') {
    return this.http.get<CommOverview>('/api/admin/communications/overview', { params: { range } });
  }

  logs(query: CommLogsQuery = {}) {
    const params: Record<string, string> = {};
    if (query.channel) params['channel'] = query.channel;
    if (query.template) params['template'] = query.template;
    if (query.q) params['q'] = query.q;
    params['limit'] = String(query.limit ?? 60);
    if (query.offset) params['offset'] = String(query.offset);
    return this.http.get<{ items: CommLogDto[]; hasMore: boolean }>(
      '/api/admin/communications/logs',
      { params },
    );
  }

  templates() {
    return this.http.get<CommTemplateDto[]>('/api/admin/communications/templates');
  }
}
