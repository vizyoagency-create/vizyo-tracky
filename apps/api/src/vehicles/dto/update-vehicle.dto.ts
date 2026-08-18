import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { InstallationEnergy, VehicleType } from '@prisma/client';

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  @Length(1, 20)
  /**
   * ⚠️ QUATRE CARACTERES UTILES AU MINIMUM — ajoute le 2026-08-18.
   *
   * `Length(1, 20)` acceptait « FT- », et un vehicule est parti en production avec cette
   * plaque : une saisie interrompue, validee sans un mot. Le formulaire a ete corrige,
   * mais un formulaire n'est pas une garde — un appel d'API direct passait encore.
   *
   * On compte les caracteres ALPHANUMERIQUES, pas la longueur brute : « FT- » en a deux,
   * « AB-123-CD » en a sept. Le seuil reste volontairement bas pour ne rien presumer des
   * plaques etrangeres — ce parc en compte une, KSR370, qui en a six. Verifie avant
   * d'ecrire : aucun des vehicules existants n'a moins de quatre caracteres utiles.
   */
  @Matches(/^(?:[^A-Za-z0-9]*[A-Za-z0-9]){4,}/, {
    message: 'plate : la plaque doit comporter au moins 4 caractères (lettres ou chiffres).',
  })
  plate?: string;

  @IsOptional()
  @IsEnum(VehicleType)
  type?: VehicleType;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  brand?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  model?: string;

  // Sprint 10 — type de carburant (synchro depuis le planning d'installation).
  @IsOptional()
  @IsEnum(InstallationEnergy)
  energy?: InstallationEnergy;

  @IsOptional()
  @IsInt()
  @Min(1950)
  @Max(new Date().getFullYear() + 1)
  year?: number;

  @IsOptional()
  @IsString()
  @Length(1, 30)
  color?: string;

  // Sprint 8 — caractéristiques pour les critères de réservation.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  seats?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  childSeats?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  features?: string[];

  @IsOptional()
  @IsUUID()
  fleetId?: string;
}
