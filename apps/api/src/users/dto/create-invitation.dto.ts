import { IsEmail, IsEnum, IsObject, IsOptional, IsUUID } from 'class-validator';
import { UserRole } from '@prisma/client';

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
}
