import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** feat/comptes-conducteurs (4b) — corps du déverrouillage conducteur par QR + proximité. */
export class UnlockDriverDto {
  /** Jeton signé porté par le QR (`<vehicleId>.<hmac>`). */
  @IsString()
  @MaxLength(400)
  token!: string;

  /** Latitude du téléphone du conducteur (contrôle de proximité). */
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  /** Longitude du téléphone du conducteur. */
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  /** Précision GPS en mètres (indicatif, non bloquant). */
  @IsOptional()
  @IsNumber()
  accuracy?: number;
}
