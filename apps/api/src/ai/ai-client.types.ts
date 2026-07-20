import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Couche IA multi-provider (2026-07) — contrat COMMUN à tous les moteurs (Claude, GPT…).
 *
 * Historiquement il n'y avait qu'`AnthropicClient`. On abstrait ici l'interface (`AiClient`) pour
 * pouvoir router entre plusieurs providers (switch/mixte piloté depuis la page « Coûts IA ») SANS
 * toucher aux appelants : agenda, optimiseur, booking vocal, rapports d'activité, analyse de trajets.
 * L'app PROPOSE via l'IA (JSON garanti par le schéma) ; l'app VALIDE. Le coût est tracé par modèle.
 */

/** Providers IA supportés. `claude` = Anthropic Messages API ; `gpt` = OpenAI Responses API. */
export type AiProvider = 'claude' | 'gpt';

/** MODE réglé globalement : un seul moteur, ou `both` = MIXTE (les 2 + synthèse). */
export type AiProviderMode = AiProvider | 'both';

/** Nature d'un échec IA — pour classer le niveau d'alerte + l'anti-spam (pas de match texte fragile). */
export type AiErrorKind =
  | 'no_key'
  | 'invalid_key'
  | 'quota'
  /** Fournisseur saturé (HTTP 529 Anthropic / 503) — passager, réessayable. */
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'refusal'
  | 'empty'
  | 'parse'
  | 'truncated'
  | 'http';

/**
 * Échecs PASSAGERS côté fournisseur : ni un bug de l'app, ni une action à mener. Ils ne doivent
 * donc pas remplir le centre d'alerte ni déclencher la vigie de saturation — au même titre que les
 * 429 de Vizyo Auth, déjà filtrés dans `all-exceptions.filter`.
 * (2026-07-20 : des 529 « Overloaded » d'Anthropic remontaient en ERROR pendant les récits de trajet.)
 */
const TRANSIENT_KINDS: ReadonlySet<AiErrorKind> = new Set<AiErrorKind>(['quota', 'overloaded', 'timeout', 'network']);

/** Échec IA typé (toujours un 503 pour l'appelant) portant son `kind` pour la journalisation. */
export class AiServiceError extends ServiceUnavailableException {
  /**
   * Marqueur lu par `ErrorLogger` **en canard-typage** (aucun import du module IA côté
   * observabilité, donc aucun cycle) : tout échec qui se déclare transitoire est journalisé
   * localement mais PAS persisté au centre d'alerte.
   */
  public readonly transient: boolean;

  constructor(
    public readonly kind: AiErrorKind,
    message: string,
  ) {
    super(message);
    this.transient = TRANSIENT_KINDS.has(kind);
  }
}

/** Une requête IA → une réponse JSON structurée. Identique quel que soit le provider. */
export interface AiJsonRequest {
  /** System prompt (préfixe stable → mis en cache quand le provider le supporte). */
  system: string;
  /** Données de la requête, sérialisées en JSON comme message user. */
  userPayload: unknown;
  /** JSON Schema de la sortie attendue (Structured Outputs). */
  schema: unknown;
  maxTokens?: number;
}

/** Consommation de tokens renvoyée par le provider — base du calcul de coût (palier « Coûts IA »). */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/** Résultat d'un appel : sortie JSON + consommation + modèle + provider + latence. */
export interface AiJsonResult<T> {
  result: T;
  usage: AiUsage;
  /** Nom exact du modèle renvoyé par le provider (ex. `claude-opus-4-8`, `gpt-4.1`). */
  model: string;
  /** Provider ayant réellement traité l'appel (pour l'attribution de coût + l'UI « qui a répondu »). */
  provider: AiProvider;
  latencyMs: number;
}

/** Contrat commun d'un moteur IA. Implémenté par AnthropicClient (claude) et OpenAiClient (gpt). */
export interface AiClient {
  /** Identité du provider (constante). */
  readonly provider: AiProvider;
  /** Vrai si une clé API est présente côté serveur pour CE provider. */
  isConfigured(): boolean;
  /** Un appel = une réponse JSON structurée (validée par `schema`). Lève `AiServiceError` (503) sinon. */
  completeJson<T>(req: AiJsonRequest): Promise<AiJsonResult<T>>;
}
