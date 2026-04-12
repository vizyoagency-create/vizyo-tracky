import { IsBoolean, IsEnum, IsObject, IsOptional, IsString } from 'class-validator';
import { UserRole } from '@prisma/client';
import type { UserPermissions } from '../default-permissions';

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsOptional()
  lastName?: string;

  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @IsObject()
  @IsOptional()
  permissions?: UserPermissions;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
