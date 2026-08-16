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
  /**
   * Ce que ces appels ont réellement PRODUIT — « 418 trajets analysés ce mois ».
   *
   * La page disait ce que l'IA coûte sans jamais dire ce qu'elle rend : une
   * facture sans ligne. Le coût seul ne permet aucune décision — c'est le
   * rapport entre les deux qui en permet une.
   *
   * ⚠️ `null` = **non compté**, pas « zéro ». Les appels antérieurs à ce champ
   * n'ont jamais enregistré leur nombre de résultats, et afficher « 0 résultat »
   * pour un mois passé serait un mensonge tranquille. L'écran se tait alors.
   */
  resultats: number | null;
  /**
   * Ce que la fonction produit, au pluriel et en français : « trajets analysés »,
   * « lieux qualifiés »… Nommé par le SERVEUR, qui seul connaît la liste des
   * actions — le client n'a pas à deviner l'unité d'un compteur.
   * `null` quand l'action est inconnue ou que la ligne n'agrège pas une action.
   */
  resultatsLibelle: string | null;
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
  /**
   * Flotte SCOPÉE par la vue (société ciblée par le filtre société d'un super-admin, ou la flotte
   * d'un fleet-admin) : identité + INTERRUPTEUR MAÎTRE IA. `null` en vue « toutes les sociétés ».
   * Permet de piloter l'IA PAR SOCIÉTÉ directement depuis la page Coûts IA (opt-in owner).
   */
  scopedFleet: { id: string; name: string; aiEnabled: boolean } | null;
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

/**
 * MODE de moteur IA reglé globalement. `claude`/`gpt` = un seul moteur ; `both` = MIXTE (les 2
 * moteurs analysent, puis un agent combine/complète le meilleur des deux — appliqué à l'analyse de
 * trajets). Pour les autres usages IA (single-shot), `both` retombe sur le moteur primaire.
 */
export type AiProviderMode = AiProviderId | 'both';

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
  /** MODE global : un seul moteur (`claude`/`gpt`) ou le MIXTE (`both`). */
  provider: AiProviderMode;
  updatedAt: string | null;
  providers: AiProviderInfoDto[];
  /** Vrai si le mode mixte est disponible (les 2 moteurs ont une clé). */
  mixteAvailable: boolean;
}

/** Change le mode IA global (super-admin). */
export interface SetAiProviderDto {
  provider: AiProviderMode;
}

/**
 * État de l'IA pour l'utilisateur courant. `enabled` = l'IA est UTILISABLE (clé présente côté serveur
 * ET interrupteur maître de la flotte activé). Sert au front à masquer les actions IA quand l'IA est
 * coupée. L'analyse déterministe des trajets (arrêts/excès/stations/scores) n'est PAS de l'IA et
 * reste disponible même si `enabled` est faux.
 */
export interface AiStatusDto {
  /** Au moins une clé provider (Claude/GPT) présente côté serveur. */
  configured: boolean;
  /** IA utilisable pour la flotte de l'utilisateur (config + interrupteur maître ON). */
  enabled: boolean;
  fleetId: string | null;
  /**
   * Disponibilité RÉELLE par fonctionnalité, telle que le serveur l'appliquera.
   *
   * ⚠️ `enabled` seul ne suffit PAS à décider d'afficher un bouton. Le serveur cumule trois
   * verrous — clé provider, kill-switch GLOBAL par fonction (owner), interrupteur société —
   * mais `enabled` n'en reflétait que deux. Couper `tripAnalysis` pour tout le monde laissait
   * donc « Générer le récit IA » à l'écran : l'utilisateur cliquait, le serveur refusait.
   *
   * Le front doit gater chaque affordance sur SA clé, jamais sur `enabled`.
   */
  features: Record<AiFeatureKey, boolean>;
}

/** Interrupteur maître IA d'une flotte (fleet-admin = sa flotte ; super-admin = `fleetId` ciblé). */
export interface SetAiEnabledDto {
  fleetId?: string;
  enabled: boolean;
}

/** Réglage IA courant d'une flotte (pour l'UI de réglages). */
export interface FleetAiSettingDto {
  fleetId: string;
  enabled: boolean;
}

/* ── Switchboard IA (2026-07) — interrupteurs GLOBAUX par fonctionnalité (super-admin/owner) ── */

/** Fonctionnalités IA pilotables globalement. `activityReport` = outil owner (super-admin only). */
export type AiFeatureKey = 'tripAnalysis' | 'agendaAgent' | 'capacity' | 'placement' | 'bookingParse' | 'activityReport' | 'placeAnalysis';

/**
 * LA liste des fonctionnalités IA, partagée par l'API et le front.
 *
 * ⚠️ Source unique : l'API l'énumère pour calculer `AiStatusDto.features`, le front pour typer
 * ses gardes. Deux listes séparées finiraient par diverger, et une fonction absente de la liste
 * n'aurait AUCUNE entrée dans `features` — le front la lirait `undefined`, donc « indisponible »,
 * et masquerait une fonction pourtant payée.
 */
export const AI_FEATURE_KEYS = [
  'tripAnalysis',
  'agendaAgent',
  'capacity',
  'placement',
  'bookingParse',
  'activityReport',
  'placeAnalysis',
] as const satisfies readonly AiFeatureKey[];

/**
 * Verrou d'EXHAUSTIVITÉ. `satisfies` ci-dessus ne vérifie qu'un sens (chaque entrée est une clé
 * valide) ; il laisserait passer une liste incomplète. Ici, si une clé du type manque à la liste,
 * `Exclude<…>` cesse d'être `never` et cette ligne ne compile plus.
 *
 * Preuve : retirer `'placeAnalysis'` de la liste → « Type '"placeAnalysis"' does not satisfy the
 * constraint 'never' ».
 */
type _AiFeatureKeysExhaustive<T extends never> = T;
export type _AiFeatureKeysCheck = _AiFeatureKeysExhaustive<
  Exclude<AiFeatureKey, (typeof AI_FEATURE_KEYS)[number]>
>;

/** État des interrupteurs globaux (true = fonction disponible, sous réserve du droit + interrupteur société). */
export type AiFeatureFlagsDto = Record<AiFeatureKey, boolean>;

/** Corps : couper/activer une fonctionnalité IA POUR TOUT LE MONDE (super-admin). */
export interface SetAiFeatureFlagDto {
  feature: AiFeatureKey;
  enabled: boolean;
}
