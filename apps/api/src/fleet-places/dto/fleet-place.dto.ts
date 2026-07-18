import { FleetPlaceKind } from '@prisma/client';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

const KINDS = [
  FleetPlaceKind.FUEL_STATION,
  FleetPlaceKind.PARKING,
  FleetPlaceKind.DEPOT,
  FleetPlaceKind.OTHER,
];

/** Création d'un lieu clé : parking/stationnement posé à la main, ou validation d'une station détectée. */
export class CreateFleetPlaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsIn(KINDS)
  kind!: FleetPlaceKind;

  @IsNumber()
  lat!: number;

  @IsNumber()
  lng!: number;

  /** Rayon de rattachement (m). Défaut 120 côté service. */
  @IsOptional()
  @IsNumber()
  @Min(10)
  radiusM?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  /** Station d'origine quand on VALIDE une station détectée (FuelStation.id). */
  @IsOptional()
  @IsUUID()
  stationId?: string | null;

  /** Société ciblée — super-admin uniquement (ignoré pour les autres, bornés à leur flotte). */
  @IsOptional()
  @IsUUID()
  fleetId?: string;
}

/** Modification d'un lieu clé (tout est optionnel). */
export class UpdateFleetPlaceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(KINDS)
  kind?: FleetPlaceKind;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsOptional()
  @IsNumber()
  @Min(10)
  radiusM?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}
