import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateTrackerDto {
  @IsOptional()
  @IsString()
  model?: string;

  /**
   * V1.7 — Toggle SUPER_ADMIN : indique si le fil ACC du boitier est connecte.
   * Si false, le serveur infere l'ignition depuis la vitesse GPS.
   * Reserve aux SUPER_ADMIN (verifie dans TrackersService.update).
   */
  @IsOptional()
  @IsBoolean()
  accConnected?: boolean;

  /**
   * V1.14 — Numero de la SIM data du tracker (E.164, ex +33612345678).
   * Chaine vide = effacer. Utilise pour le fallback SMS + l'allowlist vizyo-texto
   * (auto-sync via l'event tracker.sim-changed).
   */
  @IsOptional()
  @IsString()
  @Matches(/^(\+[1-9]\d{6,14})?$/, {
    message: 'simPhoneNumber: format E.164 attendu (ex +33612345678) ou vide',
  })
  simPhoneNumber?: string;
}
