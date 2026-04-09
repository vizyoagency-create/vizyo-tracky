import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export class CreateVehicleDto {
  @IsString()
  @Length(1, 20)
  plate!: string;

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

  @IsOptional()
  @IsUUID()
  fleetId?: string;
}
