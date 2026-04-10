import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { GeofenceRule } from '@prisma/client';

export class CreateGeofenceDto {
  @IsString()
  name!: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  centerLat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  centerLng!: number;

  @IsNumber()
  @Min(50)
  @Max(50000)
  radiusMeters!: number;

  @IsEnum(GeofenceRule)
  rule!: GeofenceRule;

  @IsOptional()
  @IsString()
  color?: string;
}
