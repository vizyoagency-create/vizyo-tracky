import { IsIn } from 'class-validator';
import type { AiProviderId } from '@vizyo/tracky-shared';

/** Change le moteur IA global (Claude ↔ GPT). Super-admin. */
export class SetAiProviderBodyDto {
  @IsIn(['claude', 'gpt'])
  provider!: AiProviderId;
}
