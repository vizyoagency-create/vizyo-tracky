import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AiFeatureFlagsDto,
  AiFeatureKey,
  AiProviderMode,
  AiProviderSettingsDto,
  AiUsageBudgetDto,
  AiUsageLogsPageDto,
  AiUsageSummaryDto,
  SetAiBudgetDto,
} from '@vizyo/tracky-shared';
import { Observable } from 'rxjs';

/**
 * Palier « Coûts IA » — client HTTP du tableau de bord super-admin des dépenses IA.
 * Tous les endpoints sont gardés SUPER_ADMIN côté serveur.
 */
@Injectable({ providedIn: 'root' })
export class AiUsageApiService {
  private readonly http = inject(HttpClient);

  /**
   * KPIs + répartitions (type/flotte/utilisateur/jour) + budget, sur une fenêtre.
   * `fleetId` : le super-admin peut cibler une société ; ignoré pour un fleet-admin (forcé serveur).
   */
  summary(from?: string, to?: string, fleetId?: string): Observable<AiUsageSummaryDto> {
    const params: Record<string, string> = {};
    if (from) params['from'] = from;
    if (to) params['to'] = to;
    if (fleetId) params['fleetId'] = fleetId;
    return this.http.get<AiUsageSummaryDto>('/api/admin/ai-usage/summary', { params });
  }

  /**
   * Journal des appels (curseur temporel `before` = ISO ; `after` = borne basse pour un filtre jour),
   * filtrable par action et, depuis C3 point 5, restreignable aux échecs (`failed`).
   */
  logs(opts: { limit?: number; before?: string; after?: string; userId?: string; fleetId?: string; action?: string; failed?: boolean } = {}): Observable<AiUsageLogsPageDto> {
    const params: Record<string, string> = {};
    if (opts.limit) params['limit'] = String(opts.limit);
    if (opts.before) params['before'] = opts.before;
    if (opts.after) params['after'] = opts.after;
    if (opts.userId) params['userId'] = opts.userId;
    if (opts.fleetId) params['fleetId'] = opts.fleetId;
    if (opts.action) params['action'] = opts.action;
    if (opts.failed) params['failed'] = '1';
    return this.http.get<AiUsageLogsPageDto>('/api/admin/ai-usage/logs', { params });
  }

  getBudget(): Observable<AiUsageBudgetDto> {
    return this.http.get<AiUsageBudgetDto>('/api/admin/ai-usage/budget');
  }

  /** Règle le plafond mensuel et, s'il est fourni, le taux USD→€ appliqué à tous les montants en euros. */
  setBudget(monthlyBudgetEur: number, usdToEurRate?: number): Observable<AiUsageBudgetDto> {
    const body: SetAiBudgetDto = usdToEurRate !== undefined ? { monthlyBudgetEur, usdToEurRate } : { monthlyBudgetEur };
    return this.http.put<AiUsageBudgetDto>('/api/admin/ai-usage/budget', body);
  }

  /** Moteur IA global sélectionné + moteurs disponibles (switch Claude ↔ GPT, super-admin). */
  getProvider(): Observable<AiProviderSettingsDto> {
    return this.http.get<AiProviderSettingsDto>('/api/admin/ai-usage/provider');
  }

  /** Bascule le mode IA global (Claude / GPT / les 2 mixte). */
  setProvider(provider: AiProviderMode): Observable<AiProviderSettingsDto> {
    return this.http.put<AiProviderSettingsDto>('/api/admin/ai-usage/provider', { provider });
  }

  /** Switchboard — interrupteurs GLOBAUX par fonctionnalité IA (super-admin). */
  getFeatures(): Observable<AiFeatureFlagsDto> {
    return this.http.get<AiFeatureFlagsDto>('/api/admin/ai-usage/features');
  }

  setFeature(feature: AiFeatureKey, enabled: boolean): Observable<AiFeatureFlagsDto> {
    return this.http.put<AiFeatureFlagsDto>('/api/admin/ai-usage/features', { feature, enabled });
  }
}
