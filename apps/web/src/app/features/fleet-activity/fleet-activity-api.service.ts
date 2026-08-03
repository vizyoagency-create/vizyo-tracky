import { QUIET_ERRORS_HEADER } from '../../core/interceptors/auth.interceptor';
import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type { ActivityFeedItemDto, EngineCommandAuditDto, OnlineUserDto } from '@vizyo/tracky-shared';

/**
 * Client REST de l'« Activité de la flotte » (FLEET_ADMIN). Miroir restreint de
 * UserActivityApiService : en ligne + historique + commandes moteur UNIQUEMENT (pas de
 * stats/rapports). Le back borne à la flotte de l'appelant et exclut les rôles élevés.
 */
@Injectable({ providedIn: 'root' })
export class FleetActivityApiService {
  private readonly http = inject(HttpClient);

  /**
   * Présence en direct. Appel de FOND, resondé toutes les 5 s — silencieux en cas de
   * panne, sinon une API tombée noierait l'écran sous un toast toutes les 5 secondes.
   */
  online(): Observable<OnlineUserDto[]> {
    return this.http.get<OnlineUserDto[]>('/api/fleet-admin/activity/online', {
      headers: { [QUIET_ERRORS_HEADER]: '1' },
    });
  }

  feed(opts: { limit?: number; before?: string; beforeId?: string; userId?: string; type?: string } = {}): Observable<ActivityFeedItemDto[]> {
    let params = new HttpParams().set('limit', String(opts.limit ?? 50));
    if (opts.before) params = params.set('before', opts.before);
    if (opts.beforeId) params = params.set('beforeId', opts.beforeId);
    if (opts.userId) params = params.set('userId', opts.userId);
    if (opts.type) params = params.set('type', opts.type);
    return this.http.get<ActivityFeedItemDto[]>('/api/fleet-admin/activity/feed', { params });
  }

  /** Audit des coupures/rallumages moteur de la flotte (cursor `before`). */
  engineCommands(limit = 50, before?: string, action?: string, status?: string): Observable<EngineCommandAuditDto[]> {
    let params = new HttpParams().set('limit', String(limit));
    if (before) params = params.set('before', before);
    if (action) params = params.set('action', action);
    if (status) params = params.set('status', status);
    return this.http.get<EngineCommandAuditDto[]>('/api/fleet-admin/activity/engine-commands', { params });
  }
}
