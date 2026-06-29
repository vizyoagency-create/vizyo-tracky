import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { VehicleType } from '@prisma/client';

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  @Length(1, 20)
  plate?: string;

  @IsOptional()
  @IsEnum(VehicleType)
  type?: VehicleType;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  brand?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(1950)
  @Max(new Date().getFullYear() + 1)
  year?: number;

  @IsOptional()
  @IsString()
  @Length(1, 30)
  color?: string;

  // Sprint 8 — caractéristiques pour les critères de réservation.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  seats?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  childSeats?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  features?: string[];

  @IsOptional()
  @IsUUID()
  fleetId?: string;
}
