import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  ActivityFeedItemDto,
  ActivityStatsDto,
  EngineCommandAuditDto,
  OnlineUserDto,
  SystemActivityDto,
} from '@vizyo/tracky-shared';

/** Client REST du tracking d'activité (lecture admin, SUPER_ADMIN). */
@Injectable({ providedIn: 'root' })
export class UserActivityApiService {
  private readonly http = inject(HttpClient);

  online(): Observable<OnlineUserDto[]> {
    return this.http.get<OnlineUserDto[]>('/api/admin/activity/online');
  }

  feed(opts: {
    limit?: number;
    before?: string;
    beforeId?: string;
    userId?: string;
    type?: string;
  } = {}): Observable<ActivityFeedItemDto[]> {
    let params = new HttpParams().set('limit', String(opts.limit ?? 50));
    if (opts.before) params = params.set('before', opts.before);
    if (opts.beforeId) params = params.set('beforeId', opts.beforeId);
    if (opts.userId) params = params.set('userId', opts.userId);
    if (opts.type) params = params.set('type', opts.type);
    return this.http.get<ActivityFeedItemDto[]>('/api/admin/activity/feed', { params });
  }

  stats(from?: string, to?: string): Observable<ActivityStatsDto> {
    let params = new HttpParams();
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http.get<ActivityStatsDto>('/api/admin/activity/stats', { params });
  }

  /** Audit des commandes moteur (coupe-circuit) — historique paginé (cursor `before`). */
  engineCommands(
    limit = 50,
    before?: string,
    action?: string,
    status?: string,
  ): Observable<EngineCommandAuditDto[]> {
    let params = new HttpParams().set('limit', String(limit));
    if (before) params = params.set('before', before);
    if (action) params = params.set('action', action);
    if (status) params = params.set('status', status);
    return this.http.get<EngineCommandAuditDto[]>('/api/admin/activity/engine-commands', {
      params,
    });
  }

  /** Palier B — journal des actions AUTO/système (arrière-plan) : e-mails, SMS, push, moteur… */
  systemFeed(opts: {
    limit?: number;
    before?: string;
    beforeId?: string;
    category?: string;
    status?: string;
  } = {}): Observable<SystemActivityDto[]> {
    let params = new HttpParams().set('limit', String(opts.limit ?? 60));
    if (opts.before) params = params.set('before', opts.before);
    if (opts.beforeId) params = params.set('beforeId', opts.beforeId);
    if (opts.category) params = params.set('category', opts.category);
    if (opts.status) params = params.set('status', opts.status);
    return this.http.get<SystemActivityDto[]>('/api/admin/activity/system', { params });
  }
}
