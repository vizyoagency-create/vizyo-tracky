import { IsBoolean, IsOptional, IsString } from 'class-validator';

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
}
