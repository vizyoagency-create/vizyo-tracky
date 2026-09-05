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
/**
 * Modèle par défaut, quand l'appelant n'en impose pas.
 *
 * ── POURQUOI CE N'EST PLUS OPUS ──────────────────────────────────────────────────────
 *
 * Relevé du 2026-08-19 : 51,65 $ de facture IA, dont 45,89 $ (89 %) pour 4 410 récits de trajet.
 * Chaque récit passait par `claude-opus-4-8` non par choix, mais parce que le modèle était écrit
 * en dur ici. Raconter un trajet en trois phrases ne demande pas le modèle le plus cher.
 *
 * Sonnet 5 est à la fois PLUS RÉCENT et MOINS CHER qu'Opus 4.8 : 2/10 $ par million de jetons
 * (entrée/sortie ; cache 2,50 $ à l'écriture, 0,20 $ à la lecture — page tarifaire officielle
 * relevée le 2026-09-05) contre 5/25 $, soit 60 % de moins à volume identique. Le commentaire
 * disait 3/15 $ jusqu'au 05/09 : c'est ce même chiffre faux que la grille « Coûts IA » comptait
 * (26 lignes Sonnet 5 = 0,891 $ stockés contre 0,594 $ recalculés) — la grille est corrigée par
 * le point 4 du chantier C3. Surchargeable par `ANTHROPIC_MODEL`, et par appel via
 * `AiJsonRequest.model` pour les tâches qui méritent vraiment davantage.
 */
const DEFAULT_MODEL = 'claude-sonnet-5';

/** Modèle retenu pour un appel : choix de l'appelant, sinon variable d'env, sinon défaut. */
export function resolveModel(demande?: string): string {
  return demande || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}
/** Borne le temps d'attente (adaptive thinking + effort high peut être long). */
const REQUEST_TIMEOUT_MS = 120_000;

// Rétro-compat : ces symboles étaient exportés d'ici (des appelants les importent encore de ce module).
export { AiServiceError } from './ai-client.types';
export type { AiErrorKind, NiveauEchecIa } from './ai-client.types';

@Injectable()
export class AnthropicClient implements AiClient {
  private readonly logger = new Logger(AnthropicClient.name);
  readonly provider: AiProvider = 'claude';

  /** Vrai si une clé API est présente côté serveur. */
  isConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  /** Le modèle que `completeJson` emploierait — même résolution, sans appel (cf. `AiClient`). */
  modelFor(req?: Pick<AiJsonRequest, 'model'>): string {
    return resolveModel(req?.model);
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

    const modele = resolveModel(req.model);
    const body = {
      model: modele,
      max_tokens: req.maxTokens ?? 8192,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: req.effort ?? 'high',
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
      // TRK-061 — compte sans crédit : le fournisseur REFUSE de servir pour une raison
      // contractuelle. Ni une faute d'appel, ni un aléa passager. Le message rendu au client ne
      // nomme aucun sous-traitant ; le motif du fournisseur part dans `detail`, pour le centre
      // d'alerte seul. Deux publics, deux chaînes.
      // ⚠️ Évalué AVANT la branche 429, comme dans le client GPT (chantier C3) : Anthropic envoie
      // aujourd'hui ce refus en 400, mais OpenAI l'envoie en 429 — un défaut corrigé d'un seul
      // côté revient par l'autre, et un compte à sec classé « quota » serait un échec passager
      // invisible, mis 60 s à l'écart puis retenté sans fin.
      if (isUnfundedRequest(text)) {
        throw new AiServiceError('provider_unfunded', MESSAGE_COMPTE_SANS_CREDIT, describeProviderError(text));
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
    // ══ À PARTIR D'ICI, LE FOURNISSEUR A RÉPONDU : LES JETONS SONT FACTURÉS ═══════════════
    // Un refus du modèle, une sortie tronquée, une réponse vide ou un JSON invalide ont coûté
    // exactement ce que `usage` dit. L'erreur les emporte (C3 point 5) pour que le routeur
    // journalise ce coût RÉEL — sans quoi une réponse tronquée à 16 000 jetons de sortie
    // apparaîtrait comme un échec « gratuit », estimé au seul prompt.
    const facture = data.usage ? { usage: usageDepuis(data.usage), model: data.model ?? modele } : undefined;
    if (data.stop_reason === 'refusal') {
      throw new AiServiceError('refusal', "L'IA a refusé de traiter cette requête.", undefined, facture);
    }
    // Sortie plafonnée par max_tokens (le raisonnement adaptatif consomme le budget) :
    // le JSON est coupé → détecter AVANT le parse pour une erreur claire (au lieu du
    // « JSON invalide » opaque). Protège tous les appelants IA (rapport, optimiseur).
    if (data.stop_reason === 'max_tokens' || data.stop_reason === 'model_context_window_exceeded') {
      throw new AiServiceError(
        'truncated',
        'Réponse IA tronquée (limite de tokens atteinte) : requête trop volumineuse, réduisez la période ou le périmètre.',
        undefined,
        facture,
      );
    }
    const block = (data.content ?? []).find((b) => b.type === 'text' && typeof b.text === 'string');
    if (!block?.text) {
      throw new AiServiceError('empty', 'Réponse IA vide.', undefined, facture);
    }
    let result: T;
    try {
      result = JSON.parse(block.text) as T;
    } catch {
      throw new AiServiceError('parse', 'Réponse IA non conforme (JSON invalide).', undefined, facture);
    }
    return {
      result,
      usage: usageDepuis(data.usage ?? {}),
      model: data.model ?? modele,
      provider: 'claude',
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** Compteurs de la Messages API → `AiUsage` (cache Anthropic : écriture et lecture séparées). */
function usageDepuis(u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): AiUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}
