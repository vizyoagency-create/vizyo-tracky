import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';

/**
 * Lot D (RDV v2, § 2.5 / § 4.4) — ce que Vizyo Manager pousse vers Tracky.
 *
 * Manager est la source de vérité de l'identité d'un client ; Tracky la reflète. Chaque champ est
 * facultatif dans le PATCH (Manager n'envoie que ce qui a changé) ; le PUT rejoue l'état complet.
 */
export class FleetContactDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  firstName?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  lastName?: string | null;

  /** E.164 ou national français ; `null` efface. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(40)
  phone?: string | null;
}

export class PatchFleetDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => FleetContactDto)
  contact?: FleetContactDto;

  /** E-mail de notification du client → `weeklyReportEmail`. `null` ou `''` efface. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsEmail()
  @MaxLength(254)
  notificationEmail?: string | null;

  /**
   * Nouvel e-mail de CONNEXION de l'admin. ⚠️ Seulement après acceptation par Vizyo Auth (l'e-mail
   * est l'identifiant d'Auth ; Manager change Auth, puis pousse).
   */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  adminEmail?: string;

  /** Identifiant du client Manager — pose (adoption) ou confirme ; ne change jamais un `clientId` différent. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  clientId?: string;
}

/** Resynchronisation : l'état complet, idempotent. */
export class PutFleetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  clientId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => FleetContactDto)
  contact?: FleetContactDto;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsEmail()
  @MaxLength(254)
  notificationEmail?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  adminEmail?: string;

  /** Statut du client dans Manager : `false` = flotte suspendue (membres désactivés), `true` = active. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Client archivé dans Manager (Q12) : `true` archive la flotte, `false` la désarchive — idempotent. */
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class ArchiveFleetDto {
  /** Qui archive, tel que Manager le nomme (opérateur) — journalisé. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  by?: string;
}

export class DestroyFleetDto {
  /**
   * Le nom EXACT de la société, retapé — vérification supplémentaire quand Manager l'envoie ; le contrat
   * de Manager (`deleteClient()`) appelle sans corps : la garde qui reste toujours, c'est « depuis
   * l'archive seulement ».
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  confirmName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  by?: string;
}
