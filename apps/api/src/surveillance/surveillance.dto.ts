import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import {
  SurveillanceEventStatus,
  SurveillanceMode,
  SurveillanceSensitivity,
} from '@prisma/client';

const DAY_VALUES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export class UpdateSurveillanceProfileDto {
  @IsOptional()
  @IsEnum(SurveillanceMode)
  mode?: SurveillanceMode;

  @IsOptional()
  @IsEnum(SurveillanceSensitivity)
  sensitivity?: SurveillanceSensitivity;

  // Format "HH:mm" dans le fuseau de la flotte — ex "20:00" ou "06:30". C'est une heure
  // de PENDULE, pas un instant : elle n'a pas d'équivalent UTC unique (+2 h l'été, +1 h
  // l'hiver). Le champ ne change ni de nom ni de forme ; seule sa LECTURE a été corrigée
  // au lot B0′, et les valeurs déjà en base ont été converties par migration.
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'scheduleStartTime doit être au format HH:mm (00:00 - 23:59)',
  })
  scheduleStartTime?: string | null;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'scheduleEndTime doit être au format HH:mm (00:00 - 23:59)',
  })
  scheduleEndTime?: string | null;

  // Liste des jours actifs. Null/undefined = tous les jours.
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsIn(DAY_VALUES as unknown as string[], { each: true })
  scheduleDays?: string[] | null;

  /**
   * Samedi et dimanche COCHÉS sont surveillés 24 h au lieu de suivre la plage.
   * « Un week-end n'a pas d'heures ouvrées » — décision client du 2026-08-16.
   * Non transmis = inchangé ; le défaut en base est `false` pour ne rien modifier
   * aux profils déjà en service.
   */
  @IsOptional()
  @IsBoolean()
  weekendPermanent?: boolean;

  @IsOptional()
  @IsBoolean()
  triggerVibration?: boolean;

  @IsOptional()
  @IsBoolean()
  triggerMovement?: boolean;

  @IsOptional()
  @IsBoolean()
  triggerDoor?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  additionalNotifyUserIds?: string[];
}

export class AcknowledgeEventDto {
  @IsEnum(SurveillanceEventStatus)
  status!: SurveillanceEventStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}

export const SCHEDULE_DAYS = DAY_VALUES;
export type ScheduleDay = (typeof DAY_VALUES)[number];
