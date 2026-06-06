import { IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { InstallationEnergy, InstallationTaskStatus } from '@prisma/client';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Sert au POST (ajout — `plate` exige cote service) et au PATCH (modif partielle).
 * `imei`/`simNumber` editables ici : si la tache est deja provisionnee, le service
 * resynchronise le tracker lie (cf. InstallationsService.updateTask).
 */
export class UpsertInstallationTaskDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  orderIndex?: number;

  @IsOptional()
  @IsString()
  @Matches(DATE_REGEX, { message: 'scheduledDate: format YYYY-MM-DD attendu' })
  scheduledDate?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  plate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string | null;

  @IsOptional()
  @IsEnum(InstallationEnergy)
  energy?: InstallationEnergy | null;

  @IsOptional()
  @IsString()
  @Matches(DATE_REGEX, { message: 'firstRegistrationDate: format YYYY-MM-DD attendu' })
  firstRegistrationDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  cutoffProcedure?: string | null;

  @IsOptional()
  @IsEnum(InstallationTaskStatus)
  status?: InstallationTaskStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  fieldNotes?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^(\d{15})?$/, { message: 'imei: 15 chiffres attendus' })
  imei?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^(\+[1-9]\d{6,14})?$/, { message: 'simNumber: format E.164 attendu (ex +33612345678) ou vide' })
  simNumber?: string | null;
}
