import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';

export interface WireLogDto {
  id: string;
  imei: string;
  direction: 'IN' | 'OUT';
  raw: string;
  frameType: string | null;
  commandId: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
}

export interface ErrorLogDto {
  id: string;
  level: string;
  source: string;
  message: string;
  stack: string | null;
  imei: string | null;
  commandId: string | null;
  userId: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
}

export interface TimelineEntry {
  type: 'wire' | 'error';
  id: string;
  createdAt: string;
  direction?: string;
  frameType?: string | null;
  raw?: string;
  commandId?: string | null;
  level?: string;
  source?: string;
  message?: string;
}

@Injectable({ providedIn: 'root' })
export class AdminLogsService {
  private readonly http = inject(HttpClient);

  listWireLogs(params: Record<string, string> = {}) {
    return this.http.get<{ items: WireLogDto[]; total: number }>(
      '/api/admin/logs/wire',
      { params },
    );
  }

  getWireLog(id: string) {
    return this.http.get<WireLogDto>(`/api/admin/logs/wire/${id}`);
  }

  listErrorLogs(params: Record<string, string> = {}) {
    return this.http.get<{ items: ErrorLogDto[]; total: number }>(
      '/api/admin/logs/errors',
      { params },
    );
  }

  getErrorLog(id: string) {
    return this.http.get<ErrorLogDto>(`/api/admin/logs/errors/${id}`);
  }

  trackerTimeline(imei: string, limit = 100) {
    return this.http.get<{ items: TimelineEntry[] }>(
      `/api/admin/logs/tracker/${imei}/timeline`,
      { params: { limit: String(limit) } },
    );
  }
}
