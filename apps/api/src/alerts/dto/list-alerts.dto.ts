import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { AlertSeverity, AlertType } from '@prisma/client';
import { Transform } from 'class-transformer';

export class ListAlertsDto {
  @IsOptional()
  @IsEnum(AlertType)
  type?: AlertType;

  @IsOptional()
  @IsEnum(AlertSeverity)
  severity?: AlertSeverity;

  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @IsOptional()
  acknowledged?: boolean | string;

  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}
