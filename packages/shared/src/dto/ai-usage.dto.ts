/**
 * Palier « Coûts IA » — supervision des dépenses du copilote IA (super-admin).
 *
 * Chaque appel IA est journalisé — RÉUSSI (tokens + coût) et, depuis le chantier C3 du
 * 2026-09-05, ÉCHOUÉ (sorte d'échec, motif, coût réel s'il y a eu facturation, estimation sinon).
 * Le tableau de bord agrège par requête / jour / mois / flotte / utilisateur, et compare la
 * dépense du mois à un budget paramétrable (marqueur rouge à l'approche). Les coûts sont
 * calculés en USD (facturation du fournisseur) et convertis en € via un taux stocké en base
 * (`ai_budget.usdToEurRate`), modifiable depuis la page et affiché à côté des montants.
 */

export type AiUsageAction = 'capacity' | 'placement';

/** État du budget mensuel vs dépense courante. */
export type AiBudgetStatus = 'none' | 'ok' | 'warn' | 'over';

/**
 * QUI a exécuté un appel IA.
 *
 * - `api`   : crédits Anthropic consommés — c'est de l'argent réellement dépensé.
 * - `local` : agent tournant sur le poste du propriétaire, absorbé par l'abonnement
 *             Claude Code — rien n'est facturé.
 *
 * La distinction existe pour que basculer un traitement en local ne le fasse pas
 * DISPARAÎTRE des écrans de coûts. Sans elle, la dépense baisserait sans que rien ne
 * dise pourquoi, et le travail fourni gratuitement deviendrait invisible.
 */
export type AiExecutor = 'api' | 'local';

/**
 * Ce que l'abonnement local a absorbé sur la période.
 *
 * ⚠️ `estimatedCostUsd` est une ESTIMATION, jamais une mesure. Un agent local ne
 * reçoit pas de facture : on extrapole depuis le coût moyen RÉELLEMENT constaté pour
 * la même action via l'API. Quand aucune référence API n'existe pour une action, elle
 * est listée dans `actionsSansReference` et n'entre PAS dans le total — mieux vaut un
 * total incomplet et annoncé qu'un chiffre inventé.
 */
export interface AiUsageAbsorbedDto {
  /** Appels réellement exécutés en local sur la période ET réussis (donc non facturés). */
  localCalls: number;
  /** Ce que ces appels ont produit, quand c'est compté. `null` = non mesuré. */
  localResults: number | null;
  /** Estimation du coût évité, ou `null` si aucune action n'a de référence API. */
  estimatedCostUsd: number | null;
  estimatedCostEur: number | null;
  /** Libellés des actions exécutées en local sans référence API : non estimables. */
  actionsSansReference: string[];
  /**
   * Appels locaux dont la ligne PORTE ses jetons (C3 point 3 : le poste rend les jetons réels
   * depuis le 05/09) — leur part du montant est le tarif EXACT de la grille, pas une moyenne.
   * ⚠️ Ces jetons incluent le contexte propre de Claude Code (≈ 28 000 jetons de cache par
   * appel) : le montant dit ce que le poste a réellement consommé, pas ce qu'un appel API nu
   * aurait coûté. OPTIONNEL à la lecture (client déployé avant ce champ).
   */
  callsWithTokens?: number;
  /** Appels locaux sans jetons, estimés d'après la moyenne des appels API des 90 derniers jours. */
  callsEstimated?: number;
}

export interface AiUsageBudgetDto {
  /** Plafond mensuel en € (0 = non défini). */
  monthlyBudgetEur: number;
  /** Dépense du mois en cours (mois calendaire courant). */
  spentThisMonthEur: number;
  spentThisMonthUsd: number;
  /** none = pas de budget ; ok < 80% ; warn ≥ 80% ; over ≥ 100%. */
  status: AiBudgetStatus;
  /**
   * Taux USD→€ appliqué à TOUS les montants en euros de la page. Lu dans `ai_budget.usdToEurRate`
   * (défaut 0,86, marché relevé le 2026-09-05) ; avant cette date c'était 0,92 en dur, invisible,
   * soit 7 % au-dessus du marché — et le plafond mensuel se compare à cette dépense en euros.
   */
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
  /**
   * Appels en ÉCHEC (`ok = false`) parmi `calls`, quand la ligne agrège une action. Compté à
   * part pour que « 12 appels » ne cache pas « dont 10 refusés » (relevé des 03-04/09 : trois
   * jours de compte Anthropic à sec sans une seule ligne sur cette page). OPTIONNEL à la lecture.
   */
  failed?: number;
}

export interface AiUsageSummaryDto {
  from: string;
  to: string;
  /** Toutes les lignes de la fenêtre : appels réussis ET échecs (cf. `failedCalls`). */
  totalCalls: number;
  /**
   * Appels FACTURÉS : exécutant `api` et réussis. C'est le seul dénominateur honnête d'un
   * « coût par appel » — diviser par `totalCalls` mêlait les appels du poste (0 $) et les refus
   * (0 $), et le chiffre baissait quand le service marchait moins bien. OPTIONNEL à la lecture.
   */
  billedCalls?: number;
  /**
   * Coût des SEULS appels facturés — le numérateur qui va avec `billedCalls`. `totalCostUsd`, lui,
   * inclut le coût réel des échecs facturés (réponse tronquée, refus après lecture) : les diviser
   * l'un par l'autre donnait un « coût par appel » gonflé. OPTIONNELS à la lecture.
   */
  billedCostUsd?: number;
  billedCostEur?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  /** Jetons écrits en cache (Anthropic les facture 1,25× l'entrée). OPTIONNEL à la lecture. */
  totalCacheWriteTokens?: number;
  totalCostUsd: number;
  totalCostEur: number;
  usdToEurRate: number;
  /**
   * ══ LES ÉCHECS (C3 point 5, 2026-09-05) ══════════════════════════════════════════════
   * Lignes `ok = false` de la fenêtre. `failedEstimatedCostUsd` additionne, pour chacune, le coût
   * RÉEL quand le fournisseur a facturé (réponse tronquée, refus après lecture) et sinon une
   * estimation SIMPLE (jetons d'entrée ≈ longueur du prompt / 4, sortie 0). C'est un ordre de
   * grandeur marqué ≈ à l'écran, JAMAIS de l'argent compté dans le plafond mensuel.
   * OPTIONNELS à la lecture : un client déployé avant ces champs se tait au lieu d'afficher zéro.
   */
  failedCalls?: number;
  failedEstimatedCostUsd?: number;
  failedEstimatedCostEur?: number;
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
  /**
   * Part du travail absorbée par l'abonnement local sur la période.
   *
   * OPTIONNEL à la lecture : un client déployé avant ce champ doit continuer de fonctionner,
   * et un client neuf face à une API plus ancienne doit se taire plutôt que d'afficher zéro.
   */
  absorbed?: AiUsageAbsorbedDto;
}

/**
 * Sortes d'échec d'un appel IA, telles que la couche IA les classe (`AiErrorKind` côté API).
 * Recopiées ici en littéraux : le paquet partagé ne doit rien importer du serveur, et le front
 * n'a besoin que d'un libellé par sorte.
 */
export type AiUsageErrorKind =
  /** Échec définitif d'un travail de la FILE DU POSTE (3 tentatives) — rien n'a été facturé. */
  | 'travail_local'
  | 'no_key'
  | 'invalid_key'
  | 'quota'
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'refusal'
  | 'empty'
  | 'parse'
  | 'truncated'
  | 'provider_unfunded'
  | 'http';

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
  /** Exécutant de l'appel. Optionnel à la lecture (cf. `AiUsageSummaryDto.absorbed`). */
  executor?: AiExecutor;
  /** Fournisseur qui a répondu ou refusé (`claude` | `gpt`) ; `null` sur les lignes antérieures au 05/09. */
  provider?: string | null;
  /** Sorte d'échec (ligne `ok = false`) ; `null` sur un succès ou une ligne d'échec sans sorte connue. */
  errorKind?: AiUsageErrorKind | string | null;
  /** Motif du fournisseur ou message d'erreur, borné à 400 caractères. */
  errorDetail?: string | null;
  /** Coût estimé d'un échec (≈), en USD/€ — jamais compté dans le plafond mensuel. */
  estimatedCostUsd?: number | null;
  estimatedCostEur?: number | null;
  /**
   * Vrai quand `estimatedCostUsd` est une ESTIMATION (aucun usage renvoyé par le fournisseur) :
   * l'écran l'affiche avec ≈. Faux quand le coût vient des jetons réellement facturés.
   */
  estime?: boolean;
}

export interface AiUsageLogsPageDto {
  rows: AiUsageLogRowDto[];
  /** Curseur (id) pour la page suivante, ou null si terminé. */
  nextCursor: string | null;
}

/** Réglage du budget mensuel (super-admin). Le taux USD→€ est optionnel : absent = inchangé. */
export interface SetAiBudgetDto {
  monthlyBudgetEur: number;
  /** Taux USD→€ (0,5 à 1,5). Absent = on ne touche pas au taux enregistré. */
  usdToEurRate?: number;
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

/**
 * Sortes de refus qui mettent un moteur à l'écart — miroir de `REPLI_KINDS` côté API. Si l'API
 * y ajoute une sorte sans la déclarer ici, sa compilation échoue à l'affectation : c'est voulu.
 */
export type AiQuarantineKind = 'no_key' | 'invalid_key' | 'quota' | 'overloaded' | 'provider_unfunded';

/**
 * Un moteur mis à l'écart par le routeur après un refus (C3 point 1, 2026-09-05), et jusqu'à
 * quand. Pendant ce temps, les appels partent vers l'autre moteur : l'écran doit le dire, sinon
 * il affiche « Claude » pendant que GPT facture.
 */
export interface AiProviderQuarantineDto {
  provider: AiProviderId;
  kind: AiQuarantineKind;
  /** Fin de la quarantaine (ISO 8601). */
  until: string;
}

/** Réglage courant du moteur IA global + moteurs disponibles. */
export interface AiProviderSettingsDto {
  /** MODE global : un seul moteur (`claude`/`gpt`) ou le MIXTE (`both`). */
  provider: AiProviderMode;
  updatedAt: string | null;
  providers: AiProviderInfoDto[];
  /** Vrai si le mode mixte est disponible (les 2 moteurs ont une clé). */
  mixteAvailable: boolean;
  /**
   * Moteurs actuellement à l'écart après un refus (vide si aucun). OPTIONNEL à la lecture : un
   * client déployé avant ce champ continue de fonctionner, et un client neuf face à une API plus
   * ancienne se tait plutôt que d'inventer un état.
   */
  quarantines?: AiProviderQuarantineDto[];
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
