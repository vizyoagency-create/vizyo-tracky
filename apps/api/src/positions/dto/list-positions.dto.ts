import { IsOptional, IsString, IsUUID } from 'class-validator';

export class ListPositionsDto {
  @IsOptional()
  @IsUUID()
  trackerId?: string;

  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}
