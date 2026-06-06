import { IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export class CreateInstallationPlanDto {
  @IsUUID()
  fleetId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  clientName!: string;

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
}
