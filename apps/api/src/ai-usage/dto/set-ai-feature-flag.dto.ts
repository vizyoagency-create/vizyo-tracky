import { IsBoolean, IsIn } from 'class-validator';
import type { AiFeatureKey } from '@vizyo/tracky-shared';
import { AI_FEATURE_KEYS } from '@vizyo/tracky-shared';

/**
 * La liste PARTAGÉE, et non une copie : la copie locale s'était arrêtée à six clés, et
 * `placeAnalysis` — bien présent dans `AI_FEATURE_KEYS`, dans le service des drapeaux et en
 * base — était refusé en 400 par cette route. Le switchboard de la page « Coûts IA » ne pouvait
 * donc pas piloter l'analyse de lieu (C3 point 4).
 */
const FEATURES: readonly AiFeatureKey[] = AI_FEATURE_KEYS;

/** Couper/activer une fonctionnalité IA POUR TOUT LE MONDE (super-admin). */
export class SetAiFeatureFlagBodyDto {
  @IsIn(FEATURES)
  feature!: AiFeatureKey;

  @IsBoolean()
  enabled!: boolean;
}
