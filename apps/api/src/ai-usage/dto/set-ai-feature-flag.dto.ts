import { IsBoolean, IsIn } from 'class-validator';
import type { AiFeatureKey } from '@vizyo/tracky-shared';

const FEATURES: AiFeatureKey[] = ['tripAnalysis', 'agendaAgent', 'capacity', 'placement', 'bookingParse', 'activityReport'];

/** Couper/activer une fonctionnalité IA POUR TOUT LE MONDE (super-admin). */
export class SetAiFeatureFlagBodyDto {
  @IsIn(FEATURES)
  feature!: AiFeatureKey;

  @IsBoolean()
  enabled!: boolean;
}
