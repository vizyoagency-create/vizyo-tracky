import { IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/**
 * feat/comptes-conducteurs (4b/6) — corps du déverrouillage conducteur + proximité.
 * Deux entrées possibles : `token` (QR scanné) OU `vehicleId` (choix in-app depuis « Mes véhicules »).
 * Dans les deux cas l'autorisation per-véhicule + la proximité restent vérifiées côté serveur.
 */
export class UnlockDriverDto {
  /** Jeton signé porté par le QR (`<vehicleId>.<hmac>`). Optionnel si `vehicleId` fourni. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  token?: string;

  /** Véhicule choisi in-app (écran conducteur). Optionnel si `token` fourni. */
  @IsOptional()
  @IsUUID()
  vehicleId?: string;

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
