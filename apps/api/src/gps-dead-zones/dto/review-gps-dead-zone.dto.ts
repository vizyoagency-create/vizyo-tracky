import { GpsDeadZoneLabel, GpsDeadZoneStatus } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Revue opérateur d'une zone morte GPS (fiche véhicule).
 * - `status` : seules les décisions humaines sont acceptées (CONFIRMED_BENIGN / SUSPECT), plus
 *   RECURRING pour ANNULER une confirmation. LEARNING est un état automatique, non assignable.
 * - `label` : nature de la zone (parking souterrain, tunnel, brouilleur…).
 * - `note`  : commentaire libre court.
 */
export class ReviewGpsDeadZoneDto {
  @IsOptional()
  @IsIn([GpsDeadZoneStatus.CONFIRMED_BENIGN, GpsDeadZoneStatus.SUSPECT, GpsDeadZoneStatus.RECURRING])
  status?: GpsDeadZoneStatus;

  @IsOptional()
  @IsIn([
    GpsDeadZoneLabel.UNKNOWN,
    GpsDeadZoneLabel.UNDERGROUND_PARKING,
    GpsDeadZoneLabel.COVERED_PARKING,
    GpsDeadZoneLabel.TUNNEL,
    GpsDeadZoneLabel.JAMMER_SUSPECTED,
    GpsDeadZoneLabel.OTHER,
  ])
  label?: GpsDeadZoneLabel;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}
