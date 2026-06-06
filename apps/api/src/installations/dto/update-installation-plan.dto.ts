import { IsEnum, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { InstallationPlanStatus } from '@prisma/client';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateInstallationPlanDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  clientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  clientAddress?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsString()
  @Matches(DATE_REGEX, { message: 'startDate: format YYYY-MM-DD attendu' })
  startDate?: string | null;

  @IsOptional()
  @IsString()
  @Matches(DATE_REGEX, { message: 'endDate: format YYYY-MM-DD attendu' })
  endDate?: string | null;

  @IsOptional()
  @IsEnum(InstallationPlanStatus)
  status?: InstallationPlanStatus;

  /** { "YYYY-MM-DD": "theme" } ; null = effacer. Valeurs validees dans le service. */
  @IsOptional()
  @IsObject()
  dayThemes?: Record<string, string> | null;
}
