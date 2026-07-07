/**
 * Palier « Coûts IA » — supervision des dépenses du copilote IA (super-admin).
 *
 * Chaque appel Claude RÉUSSI est journalisé (tokens + coût estimé). Le tableau de bord
 * agrège par requête / jour / mois / flotte / utilisateur, et compare la dépense du mois
 * à un budget paramétrable (marqueur rouge à l'approche). Les coûts sont calculés en USD
 * (facturation Anthropic) et convertis en € via un taux configurable côté serveur.
 */

export type AiUsageAction = 'capacity' | 'placement';

/** État du budget mensuel vs dépense courante. */
export type AiBudgetStatus = 'none' | 'ok' | 'warn' | 'over';

export interface AiUsageBudgetDto {
  /** Plafond mensuel en € (0 = non défini). */
  monthlyBudgetEur: number;
  /** Dépense du mois en cours (mois calendaire courant). */
  spentThisMonthEur: number;
  spentThisMonthUsd: number;
  /** none = pas de budget ; ok < 80% ; warn ≥ 80% ; over ≥ 100%. */
  status: AiBudgetStatus;
  /** Taux USD→€ appliqué (figé côté serveur). */
  usdToEurRate: number;
  updatedAt: string | null;
}

/** Une ligne d'agrégat (par flotte / utilisateur / type / jour). */
export interface AiUsageBreakdownRowDto {
  /** Clé technique : fleetId | userId | action | 'YYYY-MM-DD'. */
  key: string;
  /** Libellé lisible : nom de flotte | email | libellé d'action | date. */
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costEur: number;
}

export interface AiUsageSummaryDto {
  from: string;
  to: string;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  totalCostEur: number;
  usdToEurRate: number;
  byAction: AiUsageBreakdownRowDto[];
  byFleet: AiUsageBreakdownRowDto[];
  byUser: AiUsageBreakdownRowDto[];
  /** Coût par jour (ordre chronologique) — tendance. */
  byDay: AiUsageBreakdownRowDto[];
  budget: AiUsageBudgetDto;
}

/** Une ligne du journal des appels (le plus récent d'abord). */
export interface AiUsageLogRowDto {
  id: string;
  createdAt: string;
  userId: string | null;
  userEmail: string | null;
  fleetId: string | null;
  fleetName: string | null;
  model: string;
  action: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  costEur: number;
  latencyMs: number | null;
  ok: boolean;
}

export interface AiUsageLogsPageDto {
  rows: AiUsageLogRowDto[];
  /** Curseur (id) pour la page suivante, ou null si terminé. */
  nextCursor: string | null;
}

/** Réglage du budget mensuel (super-admin). */
export interface SetAiBudgetDto {
  monthlyBudgetEur: number;
}

/* ── Couche IA multi-provider (2026-07) — switch Claude ↔ GPT (super-admin) ── */

/** Moteurs IA supportés. `claude` = Anthropic ; `gpt` = OpenAI. */
export type AiProviderId = 'claude' | 'gpt';

/** Un moteur IA et sa disponibilité (clé présente côté serveur). */
export interface AiProviderInfoDto {
  id: AiProviderId;
  /** Libellé lisible (ex. « Claude (Opus 4.8) », « GPT (OpenAI) »). */
  label: string;
  /** Description courte de l'usage recommandé. */
  hint: string;
  /** Vrai si une clé API est présente côté serveur pour ce moteur (sinon non sélectionnable). */
  configured: boolean;
}

/** Réglage courant du moteur IA global + moteurs disponibles. */
export interface AiProviderSettingsDto {
  /** Moteur global sélectionné (appliqué à tous les appels IA sauf surcharge « par tâche »). */
  provider: AiProviderId;
  updatedAt: string | null;
  providers: AiProviderInfoDto[];
}

/** Change le moteur IA global (super-admin). */
export interface SetAiProviderDto {
  provider: AiProviderId;
}
