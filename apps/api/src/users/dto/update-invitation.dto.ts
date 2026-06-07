import { IsEnum, IsObject, IsOptional, IsUUID } from 'class-validator';
import { UserRole } from '@prisma/client';

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
}
