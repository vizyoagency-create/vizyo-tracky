import { Injectable, Logger } from '@nestjs/common';
import type { AiClient, AiJsonRequest, AiJsonResult, AiProvider } from './ai-client.types';
import { AiServiceError, describeProviderError, isTransientBadRequest } from './ai-client.types';

/**
 * Sprint 9 — Client Claude minimal (Messages API, sortie structurée). On appelle
 * l'API directement (fetch global Node) : le format wire est IDENTIQUE à ce qui est
 * testé en Console, sans dépendance supplémentaire à verrouiller. La clé reste en
 * env (`ANTHROPIC_API_KEY`) — jamais en dur, jamais loggée. Absence de clé →
 * 503 explicite (l'app ne casse pas ; les autres fonctionnalités tournent).
 *
 * Principe : l'IA PROPOSE (JSON garanti par output_config.format) ; l'app valide.
 * 2026-07 — implémente le contrat commun `AiClient` (routable avec OpenAiClient via AiRouter).
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-opus-4-8';
/** Borne le temps d'attente (adaptive thinking + effort high peut être long). */
const REQUEST_TIMEOUT_MS = 120_000;

// Rétro-compat : ces symboles étaient exportés d'ici (des appelants les importent encore de ce module).
export { AiServiceError } from './ai-client.types';
export type { AiErrorKind } from './ai-client.types';

@Injectable()
export class AnthropicClient implements AiClient {
  private readonly logger = new Logger(AnthropicClient.name);
  readonly provider: AiProvider = 'claude';

  /** Vrai si une clé API est présente côté serveur. */
  isConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  /**
   * Un appel = une réponse JSON structurée. Adaptive thinking + effort high pour le
   * raisonnement ; prompt caching sur le system stable.
   */
  async completeJson<T>(req: AiJsonRequest): Promise<AiJsonResult<T>> {
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
      // 529 « Overloaded » (spécifique Anthropic) et 503 : le fournisseur sature. Passager et
      // réessayable — à distinguer d'une vraie erreur serveur, sinon ça alarme pour rien.
      if (res.status === 529 || res.status === 503) {
        throw new AiServiceError('overloaded', 'Service IA momentanément saturé, réessayez dans un instant.');
      }
      // 400 « déguisé » (compilation de grammaire expirée…) : aléa fournisseur, pas un appel fautif.
      // Le prochain passage du cron refera l'appel — inutile d'alerter (cf. TRANSIENT_400_PATTERNS).
      if (res.status === 400 && isTransientBadRequest(text)) {
        throw new AiServiceError(
          'overloaded',
          `Le service IA n'a pas pu préparer la réponse (${describeProviderError(text)}) — nouvelle tentative au prochain passage.`,
        );
      }
      // Vraie faute d'appel : on PORTE le motif du fournisseur jusqu'au centre d'alerte. Sans lui,
      // « Erreur du service IA (400) » obligeait à aller lire les logs du conteneur en SSH.
      throw new AiServiceError('http', `Erreur du service IA (${res.status}) : ${describeProviderError(text)}`);
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
    // Sortie plafonnée par max_tokens (le raisonnement adaptatif consomme le budget) :
    // le JSON est coupé → détecter AVANT le parse pour une erreur claire (au lieu du
    // « JSON invalide » opaque). Protège tous les appelants IA (rapport, optimiseur).
    if (data.stop_reason === 'max_tokens' || data.stop_reason === 'model_context_window_exceeded') {
      throw new AiServiceError(
        'truncated',
        'Réponse IA tronquée (limite de tokens atteinte) : requête trop volumineuse, réduisez la période ou le périmètre.',
      );
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
      provider: 'claude',
      latencyMs: Date.now() - startedAt,
    };
  }
}
