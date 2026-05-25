import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import type { UserPermissions } from '@vizyo/tracky-shared';

/**
 * V1.11 Phase 1 — Une entree de la matrice d'acces. Porte un scope (ALL, GROUP
 * ou VEHICLE) et ses permissions optionnelles. Si `permissions` est null/omis,
 * la ligne herite des permissions globales du user (User.permissions).
 */
export class AccessEntryDto {
  @IsEnum(['ALL', 'GROUP', 'VEHICLE'])
  type!: 'ALL' | 'GROUP' | 'VEHICLE';

  @IsOptional()
  @IsUUID('4')
  groupId?: string;

  @IsOptional()
  @IsUUID('4')
  vehicleId?: string;

  @IsOptional()
  @IsObject()
  permissions?: Partial<UserPermissions>;
}

/**
 * SetUserAccessDto accepte 2 formats :
 *
 *  - **Nouveau (Phase 1)** : `entries: AccessEntryDto[]` — remplace toutes les
 *    lignes existantes du user. Chaque entry porte ses permissions par scope.
 *
 *  - **Legacy** : `type: 'ALL' | 'CUSTOM' + groupIds[] + vehicleIds[]` — conserve
 *    pour ne pas casser le front actuel. Converti en entries[] avec
 *    `permissions: null` (= herite des permissions globales du user).
 */
export class SetUserAccessDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AccessEntryDto)
  entries?: AccessEntryDto[];

  // ─── Format legacy (conserve pour compat ascendante) ─────────────
  @IsOptional()
  @IsEnum(['ALL', 'CUSTOM'])
  type?: 'ALL' | 'CUSTOM';

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  groupIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  vehicleIds?: string[];
}

/**
 * Body de PATCH /users/:userId/access/:accessId — modifie les permissions
 * d'une seule ligne d'acces (utilise par les toggles de la matrice 2D).
 */
export class UpdateAccessEntryPermissionsDto {
  @IsObject()
  permissions!: Partial<UserPermissions>;
}
