import { ArrayMinSize, IsArray, IsEnum, IsNumber, IsObject, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { GeofenceRule, GeofenceType } from '@prisma/client';

export class PolygonPointDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
}

export class CreateGeofenceDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsEnum(GeofenceType)
  type?: GeofenceType;

  @IsNumber()
  @Min(-90)
  @Max(90)
  centerLat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  centerLng!: number;

  @IsNumber()
  @Min(0)
  @Max(50000)
  radiusMeters!: number;

  @IsEnum(GeofenceRule)
  rule!: GeofenceRule;

  @IsOptional()
  @IsString()
  color?: string;

  /** Sprint F.2 V1.4 : sommets polygon (>= 3) si type === POLYGON. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(3)
  @ValidateNested({ each: true })
  @Type(() => PolygonPointDto)
  polygonPoints?: PolygonPointDto[];

  /** V1.6 (P3) : polyligne corridor (>= 2 points) si type === CORRIDOR. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => PolygonPointDto)
  corridorPoints?: PolygonPointDto[];

  /** V1.6 (P3) : largeur du buffer en metres si type === CORRIDOR. */
  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(2000)
  corridorWidthM?: number;
}
