import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class CreateTrackerDto {
  @IsString()
  @Matches(/^\d{15}$/, { message: 'IMEI doit contenir exactement 15 chiffres' })
  imei!: string;

  @IsOptional()
  @IsString()
  model?: string;

  /**
   * V1.15 — Numero de la SIM data du boitier (E.164, ex +33612345678) saisi a la
   * pose / creation. Chaine vide = pas de SIM. Persiste dans Tracker.simPhoneNumber
   * et declenche l'event tracker.sim-changed (sync allowlist vizyo-texto).
   */
  @IsOptional()
  @IsString()
  @Matches(/^(\+[1-9]\d{6,14})?$/, {
    message: 'simPhoneNumber: format E.164 attendu (ex +33612345678) ou vide',
  })
  simPhoneNumber?: string;

  @IsOptional()
  @IsUUID()
  fleetId?: string;
}
