import { AiUsageService } from '../ai-usage/ai-usage.service';
import { Injectable } from '@nestjs/common';
import { AnthropicClient } from './anthropic.client';
import { OpenAiClient } from './openai.client';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import type { AiClient, AiJsonRequest, AiJsonResult, AiProvider, AiProviderMode } from './ai-client.types';
import { AiServiceError } from './ai-client.types';

/** Options d'un appel routé. `preferProvider` = mixte « par tâche » (ex. analyse de trajets → gpt). */
export interface AiRunOptions {
  preferProvider?: AiProvider;
}

/**
 * Routeur IA (2026-07) — point d'entrée UNIQUE de tous les appels IA de l'app. DROP-IN de
 * `AnthropicClient` (même `isConfigured()` + `completeJson()`), pour que les appelants existants
 * (agenda, optimiseur, booking vocal, rapports, analyse de trajets) basculent sans changer de code.
 *
 * Choix du provider, dans l'ordre : (1) `preferProvider` de l'appel (mixte par tâche), (2) le provider
 * GLOBAL réglé dans « Coûts IA », (3) repli sur n'importe quel provider CONFIGURÉ. Si aucun n'a de clé,
 * on délègue au provider sélectionné qui lèvera un 503 `no_key` clair. Le `provider` réellement utilisé
 * est renvoyé dans le résultat (attribution de coût + UI « qui a répondu »).
 */
@Injectable()
export class AiRouter {
  constructor(
    private readonly anthropic: AnthropicClient,
    private readonly openai: OpenAiClient,
    private readonly settings: AiProviderSettingsService,
    private readonly usage: AiUsageService,
  ) {}

  /** L'IA est disponible dès qu'AU MOINS un provider a une clé (l'app active alors sa couche IA). */
  isConfigured(): boolean {
    return this.anthropic.isConfigured() || this.openai.isConfigured();
  }

  /** Disponibilité par provider (clé présente côté serveur) — pour l'UI du switch « Coûts IA ». */
  availability(): Record<AiProvider, boolean> {
    return { claude: this.anthropic.isConfigured(), gpt: this.openai.isConfigured() };
  }

  private byName(p: AiProvider): AiClient {
    return p === 'gpt' ? this.openai : this.anthropic;
  }

  /** Client à utiliser : 1er CONFIGURÉ dans l'ordre de préférence ; sinon le sélectionné (→ 503 clair). */
  private pick(selected: AiProvider, prefer?: AiProvider): AiClient {
    const order: AiProvider[] = [];
    for (const p of [prefer, selected, 'claude', 'gpt'] as (AiProvider | undefined)[]) {
      if (p && !order.includes(p)) order.push(p);
    }
    for (const p of order) {
      const c = this.byName(p);
      if (c.isConfigured()) return c;
    }
    return this.byName(selected);
  }

  /** MODE global réglé (`claude` | `gpt` | `both`). Pour les décisions d'ensemble (analyse de trajets). */
  async mode(): Promise<AiProviderMode> {
    return this.settings.current();
  }

  /** true si le MIXTE est possible (les 2 moteurs ont une clé côté serveur). */
  mixteAvailable(): boolean {
    return this.anthropic.isConfigured() && this.openai.isConfigured();
  }

  /**
   * Un appel = une réponse JSON structurée, routée vers le bon provider. Lève `AiServiceError` (503).
   * Le mode `both` (mixte) n'a de sens que pour les usages qui savent lancer 2 moteurs + synthèse
   * (analyse de trajets) ; pour un appel SIMPLE, il retombe sur le moteur primaire (Claude).
   */
  async completeJson<T>(req: AiJsonRequest, opts?: AiRunOptions): Promise<AiJsonResult<T>> {
    // ══ PLAFOND MENSUEL — applique ICI, pour TOUS les appelants ═══════════════════
    //
    // Il ne gardait qu'UN des huit points d'appel (`place-analysis`). L'administrateur
    // fixait un plafond, le voyait « depasse » a l'ecran, et le cron de recits, l'agent
    // d'agenda, l'optimiseur, le rapport d'activite et la saisie vocale continuaient de
    // depenser. Un plafond qui ne plafonne pas est pire qu'aucun plafond : il donne une
    // fausse assurance.
    //
    // Ce service se declare « point d'entree UNIQUE de tous les appels IA ». C'est donc
    // le seul endroit ou la regle ne peut pas etre oubliee par un futur appelant.
    if (await this.usage.monthBudgetExhausted()) {
      throw new AiServiceError('quota', 'Plafond mensuel de depense IA atteint — appel refuse.');
    }

    const mode = await this.settings.current();
    const selected: AiProvider = mode === 'both' ? 'claude' : mode;
    return this.pick(selected, opts?.preferProvider).completeJson<T>(req);
  }
}
