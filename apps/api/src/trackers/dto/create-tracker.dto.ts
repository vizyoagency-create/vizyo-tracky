import { IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export class CreateTrackerDto {
  @IsString()
  @Matches(/^\d{15}$/, { message: 'IMEI doit contenir exactement 15 chiffres' })
  imei!: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsUUID()
  fleetId?: string;
}
