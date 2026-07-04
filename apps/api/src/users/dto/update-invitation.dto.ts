import { IsArray, IsEnum, IsObject, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '@prisma/client';
import { AccessEntryDto } from './set-access.dto';

/**
 * V1.16 (audit A1) — DTO de modification d'une invitation PENDING. Remplace le
 * `@Body()` inline de `PATCH /users/invitations/:id` pour reactiver le
 * `ValidationPipe` (`whitelist + forbidNonWhitelisted`).
 *
 * NB securite : la garde d'escalade de role/flotte (un FLEET_ADMIN ne peut pas
 * promouvoir une invitation en SUPER_ADMIN) est appliquee dans
 * `InvitationsService.update()` via `assertInviterCanGrant`, partagee avec
 * `create()`. Le DTO ne fait que valider la forme.
 */
export class UpdateInvitationDto {
  @IsUUID()
  @IsOptional()
  fleetId?: string | null;

  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @IsObject()
  @IsOptional()
  permissions?: Record<string, boolean>;

  /** Scopes d'accès (matrice) — remplace ceux de l'invitation. Cf. CreateInvitationDto. */
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AccessEntryDto)
  accessScopes?: AccessEntryDto[];
}
