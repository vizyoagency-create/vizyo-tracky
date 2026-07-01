import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Sprint 9 — Client Claude minimal (Messages API, sortie structurée). On appelle
 * l'API directement (fetch global Node) : le format wire est IDENTIQUE à ce qui est
 * testé en Console, sans dépendance supplémentaire à verrouiller. La clé reste en
 * env (`ANTHROPIC_API_KEY`) — jamais en dur, jamais loggée. Absence de clé →
 * 503 explicite (l'app ne casse pas ; les autres fonctionnalités tournent).
 *
 * Principe : l'IA PROPOSE (JSON garanti par output_config.format) ; l'app valide.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-opus-4-8';
/** Borne le temps d'attente (adaptive thinking + effort high peut être long). */
const REQUEST_TIMEOUT_MS = 120_000;

/** Nature d'un échec IA — pour classer le niveau d'alerte + l'anti-spam (pas de match texte fragile). */
export type AiErrorKind =
  | 'no_key'
  | 'invalid_key'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'refusal'
  | 'empty'
  | 'parse'
  | 'http';

/** Échec IA typé (toujours un 503 pour l'appelant) portant son `kind` pour la journalisation. */
export class AiServiceError extends ServiceUnavailableException {
  constructor(
    public readonly kind: AiErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface AnthropicJsonRequest {
  /** System prompt (préfixe stable → mis en cache). */
  system: string;
  /** Données de la requête, sérialisées en JSON comme message user. */
  userPayload: unknown;
  /** JSON Schema de la sortie attendue (output_config.format). */
  schema: unknown;
  maxTokens?: number;
}

/** Consommation de tokens renvoyée par l'API — base du calcul de coût (palier « Coûts IA »). */
export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/** Résultat d'un appel : sortie JSON + consommation + modèle + latence. */
export interface AnthropicJsonResult<T> {
  result: T;
  usage: AnthropicUsage;
  model: string;
  latencyMs: number;
}

@Injectable()
export class AnthropicClient {
  private readonly logger = new Logger(AnthropicClient.name);

  /** Vrai si une clé API est présente côté serveur. */
  isConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  /**
   * Un appel = une réponse JSON structurée. Adaptive thinking + effort high pour le
   * raisonnement ; prompt caching sur le system stable.
   */
  async completeJson<T>(req: AnthropicJsonRequest): Promise<AnthropicJsonResult<T>> {
    const startedAt = Date.now();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AiServiceError('no_key', 'Copilote IA non configuré (ANTHROPIC_API_KEY absente côté serveur).');
    }

    const body = {
      model: MODEL,
      max_tokens: req.maxTokens ?? 8192,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: req.schema },
      },
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(req.userPayload) }],
    };

    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((e: unknown) => {
      const name = (e as Error)?.name;
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      this.logger.error(`Appel Anthropic échoué (${timeout ? 'timeout' : 'réseau'}) : ${(e as Error)?.message ?? e}`);
      throw new AiServiceError(
        timeout ? 'timeout' : 'network',
        timeout ? "Le service IA n'a pas répondu à temps (timeout)." : 'Le service IA est injoignable.',
      );
    });

    if (!res.ok) {
      // La clé n'apparaît jamais dans le corps d'erreur Anthropic ; on tronque par prudence.
      const text = await res.text().catch(() => '');
      this.logger.warn(`Anthropic HTTP ${res.status} : ${text.slice(0, 300)}`);
      if (res.status === 401 || res.status === 403) {
        throw new AiServiceError('invalid_key', 'Clé IA invalide ou non autorisée.');
      }
      if (res.status === 429) {
        throw new AiServiceError('quota', 'Quota IA atteint, réessayez plus tard.');
      }
      throw new AiServiceError('http', `Erreur du service IA (${res.status}).`);
    }

    const data = (await res.json()) as {
      stop_reason?: string;
      model?: string;
      content?: Array<{ type: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    if (data.stop_reason === 'refusal') {
      throw new AiServiceError('refusal', "L'IA a refusé de traiter cette requête.");
    }
    const block = (data.content ?? []).find((b) => b.type === 'text' && typeof b.text === 'string');
    if (!block?.text) {
      throw new AiServiceError('empty', 'Réponse IA vide.');
    }
    let result: T;
    try {
      result = JSON.parse(block.text) as T;
    } catch {
      throw new AiServiceError('parse', 'Réponse IA non conforme (JSON invalide).');
    }
    const u = data.usage ?? {};
    return {
      result,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
      },
      model: data.model ?? MODEL,
      latencyMs: Date.now() - startedAt,
    };
  }
}
