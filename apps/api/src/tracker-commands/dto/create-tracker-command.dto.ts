import { IsDateString, IsOptional, IsString } from 'class-validator';

export class CreateTrackerCommandDto {
  @IsString()
  trackerId!: string;

  @IsString()
  templateId!: string;

  @IsOptional()
  params?: Record<string, unknown>;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
