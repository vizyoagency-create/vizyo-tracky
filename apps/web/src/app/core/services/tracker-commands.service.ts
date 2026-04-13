import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';

export interface TrackerCommandDto {
  id: string;
  trackerId: string;
  templateId: string;
  category: string;
  params: Record<string, unknown>;
  payload: string;
  channel: string;
  status: string;
  scheduledAt: string | null;
  sentAt: string | null;
  ackedAt: string | null;
  ackResponse: string | null;
  lastError: string | null;
  requestedBy: string;
  requestedByUser?: { email: string; firstName: string | null; lastName: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface CatalogTemplate {
  id: string;
  category: string;
  label: string;
  description: string;
  dangerous: boolean;
  requiresConfirmation: boolean;
  requiresSuperAdmin: boolean;
  params: {
    name: string;
    label: string;
    type: string;
    required: boolean;
    min?: number;
    max?: number;
    options?: { value: string; label: string }[];
  }[];
  availableVia: string[];
  ackTimeoutMs: number;
}

@Injectable({ providedIn: 'root' })
export class TrackerCommandsApiService {
  private readonly http = inject(HttpClient);

  create(body: { trackerId: string; templateId: string; params?: Record<string, unknown>; scheduledAt?: string }) {
    return this.http.post<TrackerCommandDto>('/api/tracker-commands', body);
  }

  list(params: Record<string, string> = {}) {
    return this.http.get<TrackerCommandDto[]>('/api/tracker-commands', { params });
  }

  getCatalog() {
    return this.http.get<CatalogTemplate[]>('/api/tracker-commands/catalog');
  }

  getCommand(id: string) {
    return this.http.get<TrackerCommandDto>(`/api/tracker-commands/${id}`);
  }

  cancel(id: string) {
    return this.http.delete<TrackerCommandDto>(`/api/tracker-commands/${id}`);
  }
}
