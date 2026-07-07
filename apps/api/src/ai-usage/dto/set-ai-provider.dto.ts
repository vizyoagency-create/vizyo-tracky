import { IsIn } from 'class-validator';
import type { AiProviderMode } from '@vizyo/tracky-shared';

/** Change le mode IA global (Claude / GPT / les 2 mixte). Super-admin. */
export class SetAiProviderBodyDto {
  @IsIn(['claude', 'gpt', 'both'])
  provider!: AiProviderMode;
}
