import { Injectable, Logger } from '@nestjs/common';
import type { AiClient, AiJsonRequest, AiJsonResult, AiProvider } from './ai-client.types';
import { AiServiceError } from './ai-client.types';

/**
 * Client GPT (OpenAI **Responses API** + Structured Outputs). Même contrat `AiClient` que Claude →
 * routable via AiRouter (switch/mixte piloté depuis « Coûts IA »). Clé en env (`OPENAI_API_KEY`,
 * jamais loggée) ; modèle surchargeable (`OPENAI_MODEL`, défaut gpt-4.1). Absence de clé → 503
 * explicite (l'app tourne). Le format wire suit la doc Responses API (`text.format.json_schema`).
 */

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-4.1';
const REQUEST_TIMEOUT_MS = 120_000;

@Injectable()
export class OpenAiClient implements AiClient {
  private readonly logger = new Logger(OpenAiClient.name);
  readonly provider: AiProvider = 'gpt';

  /** Vrai si une clé API OpenAI est présente côté serveur. */
  isConfigured(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  async completeJson<T>(req: AiJsonRequest): Promise<AiJsonResult<T>> {
    const startedAt = Date.now();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new AiServiceError('no_key', 'Copilote IA (GPT) non configuré (OPENAI_API_KEY absente côté serveur).');
    }
    const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

    const body = {
      model,
      instructions: req.system, // system prompt (préfixe stable → cache automatique OpenAI)
      input: JSON.stringify(req.userPayload),
      text: {
        format: {
          type: 'json_schema',
          name: 'tracky_result',
          // strict=false : nos schémas viennent d'Anthropic (pas toujours conformes au mode strict
          // OpenAI qui exige additionalProperties:false + tous requis). Best-effort = JSON quand même
          // fortement guidé ; on durcira schéma par schéma si besoin.
          strict: false,
          schema: req.schema,
        },
      },
      max_output_tokens: req.maxTokens ?? 8192,
    };

    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((e: unknown) => {
      const name = (e as Error)?.name;
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      this.logger.error(`Appel OpenAI échoué (${timeout ? 'timeout' : 'réseau'}) : ${(e as Error)?.message ?? e}`);
      throw new AiServiceError(
        timeout ? 'timeout' : 'network',
        timeout ? "Le service IA (GPT) n'a pas répondu à temps (timeout)." : 'Le service IA (GPT) est injoignable.',
      );
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.warn(`OpenAI HTTP ${res.status} : ${text.slice(0, 300)}`);
      if (res.status === 401 || res.status === 403) {
        throw new AiServiceError('invalid_key', 'Clé IA (GPT) invalide ou non autorisée.');
      }
      if (res.status === 429) {
        throw new AiServiceError('quota', 'Quota IA (GPT) atteint, réessayez plus tard.');
      }
      throw new AiServiceError('http', `Erreur du service IA (GPT) (${res.status}).`);
    }

    const data = (await res.json()) as {
      model?: string;
      status?: string;
      incomplete_details?: { reason?: string };
      output_text?: string;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      };
    };

    // Sortie plafonnée par max_output_tokens → JSON coupé : détecter AVANT le parse (erreur claire).
    if (data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens') {
      throw new AiServiceError(
        'truncated',
        'Réponse IA (GPT) tronquée (limite de tokens atteinte) : réduisez la période ou le périmètre.',
      );
    }

    const text = data.output_text ?? extractOutputText(data.output);
    if (!text) {
      // Un item `refusal` (au lieu d'`output_text`) = refus explicite du modèle.
      if (hasRefusal(data.output)) {
        throw new AiServiceError('refusal', "L'IA (GPT) a refusé de traiter cette requête.");
      }
      throw new AiServiceError('empty', 'Réponse IA (GPT) vide.');
    }

    let result: T;
    try {
      result = JSON.parse(text) as T;
    } catch {
      throw new AiServiceError('parse', 'Réponse IA (GPT) non conforme (JSON invalide).');
    }

    const u = data.usage ?? {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    return {
      result,
      usage: {
        // OpenAI compte le cache DANS input_tokens ; on isole la part cachée (tarif réduit) comme Anthropic.
        inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached),
        outputTokens: u.output_tokens ?? 0,
        cacheWriteTokens: 0, // OpenAI ne facture pas l'écriture de cache séparément.
        cacheReadTokens: cached,
      },
      model: data.model ?? model,
      provider: 'gpt',
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** Extrait le texte de sortie des items `message`/`output_text` de la Responses API. */
function extractOutputText(output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>): string | null {
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    for (const c of item.content ?? []) {
      if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string' && c.text) {
        return c.text;
      }
    }
  }
  return null;
}

/** Vrai si la sortie contient un item de refus (content.type === 'refusal'). */
function hasRefusal(output?: Array<{ content?: Array<{ type?: string }> }>): boolean {
  return !!output?.some((item) => (item.content ?? []).some((c) => c.type === 'refusal'));
}
