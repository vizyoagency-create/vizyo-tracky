import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/** Une journée du cadre : ouverte ou non + plages (multi-plages "HH:MM"). */
export interface WorkScheduleDayInput {
  enabled?: boolean;
  start?: string | null;
  end?: string | null;
  slots?: { start: string; end: string }[] | null;
}

/**
 * Cadre de temps de travail d'un véhicule (défini par le fleet-admin). Validation légère :
 * l'évaluateur `evaluateSchedule` est défensif (formats d'heure invalides ignorés). `days` est
 * un objet { monday: {...}, ... } mappé colonne par colonne côté service.
 */
export class SetWorkScheduleDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  countryCode?: string;

  @IsOptional()
  @IsObject()
  days?: Record<string, WorkScheduleDayInput>;
}
