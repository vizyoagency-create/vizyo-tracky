import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { AiUsageBudgetDto, AiUsageLogsPageDto, AiUsageSummaryDto } from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Palier « Coûts IA » — client HTTP du tableau de bord super-admin des dépenses IA.
 * Tous les endpoints sont gardés SUPER_ADMIN côté serveur.
 */
@Injectable({ providedIn: 'root' })
export class AiUsageApiService {
  private readonly http = inject(HttpClient);

  /** KPIs + répartitions (type/flotte/utilisateur/jour) + budget, sur une fenêtre. */
  summary(from?: string, to?: string): Observable<AiUsageSummaryDto> {
    const params: Record<string, string> = {};
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    return this.http.get<AiUsageSummaryDto>('/api/admin/ai-usage/summary', { params });
  }

  /** Journal des appels (curseur temporel `before` = ISO), filtrable. */
  logs(opts: { limit?: number; before?: string; userId?: string; fleetId?: string; action?: string } = {}): Observable<AiUsageLogsPageDto> {
    const params: Record<string, string> = {};
    if (opts.limit) params['limit'] = String(opts.limit);
    if (opts.before) params['before'] = opts.before;
    if (opts.userId) params['userId'] = opts.userId;
    if (opts.fleetId) params['fleetId'] = opts.fleetId;
    if (opts.action) params['action'] = opts.action;
    return this.http.get<AiUsageLogsPageDto>('/api/admin/ai-usage/logs', { params });
  }

  getBudget(): Observable<AiUsageBudgetDto> {
    return this.http.get<AiUsageBudgetDto>('/api/admin/ai-usage/budget');
  }

  setBudget(monthlyBudgetEur: number): Observable<AiUsageBudgetDto> {
    return this.http.put<AiUsageBudgetDto>('/api/admin/ai-usage/budget', { monthlyBudgetEur });
  }
}
