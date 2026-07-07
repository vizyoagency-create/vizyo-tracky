import { Global, Module } from '@nestjs/common';
import { AnthropicClient } from './anthropic.client';
import { OpenAiClient } from './openai.client';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { AiRouter } from './ai-router.service';

/**
 * Couche IA multi-provider (2026-07) — module GLOBAL fournissant les moteurs (Claude/GPT), le
 * réglage de provider et le routeur. @Global car l'IA est appelée depuis plusieurs domaines
 * (agenda, réservation, rapports, optimiseur, analyse de trajets) qui ne peuvent pas importer un
 * AiModule sans cycles ; les clients sont sans état (clé lue en env par appel), donc partageables.
 */
@Global()
@Module({
  providers: [AnthropicClient, OpenAiClient, AiProviderSettingsService, AiRouter],
  exports: [AnthropicClient, OpenAiClient, AiProviderSettingsService, AiRouter],
})
export class AiCoreModule {}
