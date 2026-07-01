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

  feed(limit = 50, before?: string): Observable<ActivityFeedItemDto[]> {
    let params = new HttpParams().set('limit', String(limit));
    if (before) params = params.set('before', before);
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
  systemFeed(limit = 60, before?: string, category?: string): Observable<SystemActivityDto[]> {
    let params = new HttpParams().set('limit', String(limit));
    if (before) params = params.set('before', before);
    if (category) params = params.set('category', category);
    return this.http.get<SystemActivityDto[]>('/api/admin/activity/system', { params });
  }
}
