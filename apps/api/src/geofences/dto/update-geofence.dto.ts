import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { GeofenceRule, GeofenceType } from '@prisma/client';
import { PolygonPointDto } from './create-geofence.dto';

export class UpdateGeofenceDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(GeofenceType)
  type?: GeofenceType;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  centerLat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  centerLng?: number;

  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(50000)
  radiusMeters?: number;

  @IsOptional()
  @IsEnum(GeofenceRule)
  rule?: GeofenceRule;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(3)
  @ValidateNested({ each: true })
  @Type(() => PolygonPointDto)
  polygonPoints?: PolygonPointDto[];
}
