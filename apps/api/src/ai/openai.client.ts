import { Injectable, Logger } from '@nestjs/common';
import type { AiClient, AiJsonRequest, AiJsonResult, AiProvider, AiUsage } from './ai-client.types';
import {
  AiServiceError,
  describeProviderError,
  isTransientBadRequest,
  isUnfundedRequest,
  MESSAGE_COMPTE_SANS_CREDIT,
} from './ai-client.types';

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

  /**
   * Le modèle que `completeJson` emploierait — la MÊME résolution que l'appel, sans appel.
   * ⚠️ `req.model` est volontairement ignoré, comme dans `completeJson` : les appelants y
   * écrivent des identifiants Anthropic (`claude-haiku-4-5`), qu'OpenAI ne connaît pas. Ce
   * client n'a qu'un modèle, réglé par `OPENAI_MODEL` ; l'estimation d'un échec doit chiffrer
   * ce modèle-là, pas celui demandé pour l'autre moteur.
   */
  modelFor(_req?: Pick<AiJsonRequest, 'model'>): string {
    return process.env.OPENAI_MODEL || DEFAULT_MODEL;
  }

  async completeJson<T>(req: AiJsonRequest): Promise<AiJsonResult<T>> {
    const startedAt = Date.now();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new AiServiceError('no_key', 'Copilote IA (GPT) non configuré (OPENAI_API_KEY absente côté serveur).');
    }
    const model = this.modelFor(req);

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
      // TRK-061 — même défaut, même correctif : le jumeau de ce client l'avait, et un défaut
      // corrigé d'un seul côté revient toujours par l'autre.
      //
      // ⚠️ C3 point 1 (2026-09-05) — évalué AVANT la branche 429. Là où Anthropic habille le
      // compte à sec en 400, OpenAI l'envoie en **429 `insufficient_quota`** : le même code que
      // la limite de débit. Testé après, il tombait dans `quota` — passager, donc jamais archivé
      // au centre d'alerte, quarantaine de 60 s au lieu de 15 min, et « réessayez plus tard »
      // servi à l'utilisateur pour une panne qui ne guérit pas seule. Un compte OpenAI à sec
      // était un échec passager invisible.
      if (isUnfundedRequest(text)) {
        throw new AiServiceError('provider_unfunded', MESSAGE_COMPTE_SANS_CREDIT, describeProviderError(text));
      }
      if (res.status === 429) {
        throw new AiServiceError('quota', 'Quota IA (GPT) atteint, réessayez plus tard.');
      }
      // Saturation côté fournisseur : passager, réessayable — pas une panne de l'app.
      if (res.status === 529 || res.status === 503) {
        throw new AiServiceError('overloaded', 'Service IA (GPT) momentanément saturé, réessayez dans un instant.');
      }
      // Même politique que Claude : un 400 « aléa fournisseur » ne remonte pas au centre d'alerte,
      // un vrai 400 y remonte AVEC le motif renvoyé (sinon diagnostic impossible sans SSH).
      if (res.status === 400 && isTransientBadRequest(text)) {
        throw new AiServiceError(
          'overloaded',
          `Le service IA (GPT) n'a pas pu préparer la réponse (${describeProviderError(text)}) — nouvelle tentative au prochain passage.`,
        );
      }
      throw new AiServiceError('http', `Erreur du service IA (GPT) (${res.status}) : ${describeProviderError(text)}`);
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

    // ══ LE FOURNISSEUR A RÉPONDU : LES JETONS SONT FACTURÉS (C3 point 5) ═════════════════
    // Même règle que le client Claude : une sortie tronquée, un refus, une réponse vide ou un
    // JSON invalide emportent l'usage réel, pour que le routeur journalise ce coût au lieu de
    // l'estimer au seul prompt.
    const facture = data.usage ? { usage: usageDepuis(data.usage), model: data.model ?? model } : undefined;

    // Sortie plafonnée par max_output_tokens → JSON coupé : détecter AVANT le parse (erreur claire).
    if (data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens') {
      throw new AiServiceError(
        'truncated',
        'Réponse IA (GPT) tronquée (limite de tokens atteinte) : réduisez la période ou le périmètre.',
        undefined,
        facture,
      );
    }

    const text = data.output_text ?? extractOutputText(data.output);
    if (!text) {
      // Un item `refusal` (au lieu d'`output_text`) = refus explicite du modèle.
      if (hasRefusal(data.output)) {
        throw new AiServiceError('refusal', "L'IA (GPT) a refusé de traiter cette requête.", undefined, facture);
      }
      throw new AiServiceError('empty', 'Réponse IA (GPT) vide.', undefined, facture);
    }

    let result: T;
    try {
      result = JSON.parse(text) as T;
    } catch {
      throw new AiServiceError('parse', 'Réponse IA (GPT) non conforme (JSON invalide).', undefined, facture);
    }

    return {
      result,
      usage: usageDepuis(data.usage ?? {}),
      model: data.model ?? model,
      provider: 'gpt',
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** Compteurs de la Responses API → `AiUsage`. */
function usageDepuis(u: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }): AiUsage {
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    // OpenAI compte le cache DANS input_tokens ; on isole la part cachée (tarif réduit) comme Anthropic.
    inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached),
    outputTokens: u.output_tokens ?? 0,
    cacheWriteTokens: 0, // OpenAI ne facture pas l'écriture de cache séparément.
    cacheReadTokens: cached,
  };
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
