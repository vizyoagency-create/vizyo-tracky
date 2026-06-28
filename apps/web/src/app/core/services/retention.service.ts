import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { RetentionFleetViewDto, RetentionOverviewDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Sprint 6 — Rétention des positions. Lecture des vues de suivi (aucune suppression côté
 * client). `refresh` recalcule le snapshot serveur (super-admin) sans rien effacer.
 */
@Injectable({ providedIn: 'root' })
export class RetentionService {
  private readonly http = inject(HttpClient);

  /** Vue super-admin : global + par flotte + config. */
  getOverview(): Observable<RetentionOverviewDto> {
    return this.http.get<RetentionOverviewDto>('/api/retention/overview');
  }

  /** Vue fleet-admin : la rétention de SA flotte + config. */
  getFleetView(): Observable<RetentionFleetViewDto> {
    return this.http.get<RetentionFleetViewDto>('/api/retention/fleet');
  }

  /** Recalcule le snapshot (super-admin). N'efface RIEN. */
  refresh(): Observable<{ computedAt: string | null }> {
    return this.http.post<{ computedAt: string | null }>('/api/retention/refresh', {});
  }
}
