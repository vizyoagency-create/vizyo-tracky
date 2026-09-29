import { QUIET_ERRORS_HEADER } from '../../core/interceptors/auth.interceptor';
import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  ActivityFeedItemDto, EngineCommandAuditDto, FleetAgendaActivityDto, OnlineUserDto,
} from '@vizyo/tracky-shared';

/** Les deux familles du fil Agenda ; '' = les deux. */
export type CategorieAgenda = '' | 'RESERVATION' | 'AGENDA';

/**
 * Client REST de l'« Activité de la flotte » (FLEET_ADMIN). Miroir restreint de
 * UserActivityApiService : en ligne + historique + commandes moteur + agenda UNIQUEMENT (pas de
 * stats/rapports). Le back borne à la flotte de l'appelant et exclut les rôles élevés.
 *
 * `fleetId` : ignoré par le serveur pour un FLEET_ADMIN (sa société est lue dans son jeton) ; un
 * SUPER_ADMIN, qui n'a pas de société, DOIT le passer — sans lui, le serveur répond une liste vide
 * (`fleetScope` du contrôleur). Le composant ne le renseigne que pour un super-admin.
 */
@Injectable({ providedIn: 'root' })
export class FleetActivityApiService {
  private readonly http = inject(HttpClient);

  /**
   * Présence en direct. Appel de FOND, resondé périodiquement — silencieux en cas de
   * panne, sinon une API tombée noierait l'écran sous un toast à chaque tour.
   */
  online(fleetId?: string | null): Observable<OnlineUserDto[]> {
    let params = new HttpParams();
    if (fleetId) params = params.set('fleetId', fleetId);
    return this.http.get<OnlineUserDto[]>('/api/fleet-admin/activity/online', {
      params,
      headers: { [QUIET_ERRORS_HEADER]: '1' },
    });
  }

  feed(opts: {
    limit?: number; before?: string; beforeId?: string; userId?: string; type?: string; fleetId?: string | null;
  } = {}): Observable<ActivityFeedItemDto[]> {
    let params = new HttpParams().set('limit', String(opts.limit ?? 50));
    if (opts.before) params = params.set('before', opts.before);
    if (opts.beforeId) params = params.set('beforeId', opts.beforeId);
    if (opts.userId) params = params.set('userId', opts.userId);
    if (opts.type) params = params.set('type', opts.type);
    if (opts.fleetId) params = params.set('fleetId', opts.fleetId);
    return this.http.get<ActivityFeedItemDto[]>('/api/fleet-admin/activity/feed', { params });
  }

  /** Audit des coupures/rallumages moteur de la flotte (cursor `before`). */
  engineCommands(
    limit = 50, before?: string, action?: string, status?: string, fleetId?: string | null,
  ): Observable<EngineCommandAuditDto[]> {
    let params = new HttpParams().set('limit', String(limit));
    if (before) params = params.set('before', before);
    if (action) params = params.set('action', action);
    if (status) params = params.set('status', status);
    if (fleetId) params = params.set('fleetId', fleetId);
    return this.http.get<EngineCommandAuditDto[]>('/api/fleet-admin/activity/engine-commands', { params });
  }

  /**
   * 29/09 — fil « Agenda » : réservations, maintenances, incidents, propositions de l'agent.
   * Curseur composite (`before` = `at` de la dernière ligne, `beforeId` = son `id`) : plusieurs
   * gestes d'un même lot partagent le même horodatage, un curseur sur la date seule en sauterait.
   */
  agenda(opts: {
    limit?: number; before?: string; beforeId?: string; category?: CategorieAgenda; fleetId?: string | null;
  } = {}): Observable<FleetAgendaActivityDto[]> {
    let params = new HttpParams().set('limit', String(opts.limit ?? 50));
    if (opts.before) params = params.set('before', opts.before);
    if (opts.beforeId) params = params.set('beforeId', opts.beforeId);
    if (opts.category) params = params.set('category', opts.category);
    if (opts.fleetId) params = params.set('fleetId', opts.fleetId);
    return this.http.get<FleetAgendaActivityDto[]>('/api/fleet-admin/activity/agenda', { params });
  }
}
