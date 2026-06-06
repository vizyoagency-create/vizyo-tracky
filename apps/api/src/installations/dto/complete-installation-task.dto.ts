import { IsEnum, IsISO8601, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { InstallationTaskStatus } from '@prisma/client';

/**
 * Pose d'une tache : capture IMEI (requis) + SIM + notes, puis provisioning auto
 * du Vehicle + Tracker (cf. InstallationsService.completeTask).
 */
export class CompleteInstallationTaskDto {
  @IsString()
  @Matches(/^\d{15}$/, { message: 'IMEI doit contenir exactement 15 chiffres' })
  imei!: string;

  @IsOptional()
  @IsString()
  @Matches(/^(\+[1-9]\d{6,14})?$/, { message: 'simNumber: format E.164 attendu (ex +33612345678) ou vide' })
  simNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  fieldNotes?: string | null;

  @IsOptional()
  @IsISO8601()
  installedAt?: string | null;

  @IsOptional()
  @IsEnum(InstallationTaskStatus)
  status?: InstallationTaskStatus;
}
