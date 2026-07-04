import { IsArray, IsEmail, IsEnum, IsObject, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '@prisma/client';
import { AccessEntryDto } from './set-access.dto';

/**
 * V1.16 (audit A1) — DTO de creation d'invitation. Remplace le `@Body()` inline
 * de `POST /users/invitations` afin de reactiver le `ValidationPipe`
 * (`whitelist + forbidNonWhitelisted`) : tout champ inconnu est rejete (400).
 *
 * Le clamp fin des `permissions` (intersection inviteur ∩ defaults du role) est
 * traite separement (lot 5). Ici on garantit seulement la forme du body ; la
 * verification d'autorite de role/flotte vit dans `InvitationsService`.
 */
export class CreateInvitationDto {
  @IsEmail()
  email!: string;

  @IsEnum(UserRole)
  role!: UserRole;

  /** Ignore pour les non-SUPER_ADMIN (force a la flotte de l'inviteur cote controleur). */
  @IsUUID()
  @IsOptional()
  fleetId?: string | null;

  @IsObject()
  @IsOptional()
  permissions?: Record<string, boolean>;

  /**
   * Scopes d'accès (matrice) configurés dès l'invitation. Chaque scope porte son
   * type (ALL/GROUP/VEHICLE) + ses permissions. Optionnel : si absent, comportement
   * legacy (un unique scope ALL dérivé de `permissions`). Clamp anti-escalade +
   * validation de flotte appliqués côté InvitationsService.
   */
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AccessEntryDto)
  accessScopes?: AccessEntryDto[];
}
