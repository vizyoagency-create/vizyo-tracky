import { IsBoolean, IsInt, Max, Min, ValidateIf } from 'class-validator';
import {
  SPEED_ALERT_ABSOLUTE_MAX_KMH,
  SPEED_ALERT_ABSOLUTE_MIN_KMH,
  SPEED_ALERT_OVER_MAX_KMH,
  SPEED_ALERT_OVER_MIN_KMH,
} from '@vizyo/tracky-shared';

/** Réglage des alertes de vitesse d'une société (lot V5). */
export class SetSpeedAlertSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  /** Dépassement minimal de la limite légale pour alerter (km/h). */
  @IsInt()
  @Min(SPEED_ALERT_OVER_MIN_KMH)
  @Max(SPEED_ALERT_OVER_MAX_KMH)
  overKmh!: number;

  /** Plafond absolu, carte ou pas (km/h) ; `null` = aucun plafond. */
  @ValidateIf((o: SetSpeedAlertSettingsDto) => o.absoluteKmh !== null)
  @IsInt()
  @Min(SPEED_ALERT_ABSOLUTE_MIN_KMH)
  @Max(SPEED_ALERT_ABSOLUTE_MAX_KMH)
  absoluteKmh!: number | null;
}

/** Dérogation d'un véhicule : chaque champ `null` hérite du réglage de la société. */
export class SetVehicleSpeedAlertOverrideDto {
  @ValidateIf((o: SetVehicleSpeedAlertOverrideDto) => o.enabled !== null)
  @IsBoolean()
  enabled!: boolean | null;

  @ValidateIf((o: SetVehicleSpeedAlertOverrideDto) => o.overKmh !== null)
  @IsInt()
  @Min(SPEED_ALERT_OVER_MIN_KMH)
  @Max(SPEED_ALERT_OVER_MAX_KMH)
  overKmh!: number | null;
}
