import { IsEmail, IsOptional, IsString } from 'class-validator';

export class ProvisionFleetDto {
  @IsString()
  fleetName!: string;

  @IsString()
  @IsOptional()
  clientId?: string;

  @IsString()
  adminAuthUserId!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @IsOptional()
  adminFirstName?: string;

  @IsString()
  @IsOptional()
  adminLastName?: string;

  /** Téléphone du contact (E.164 ou national français) — lot A. */
  @IsString()
  @IsOptional()
  adminPhone?: string;
}

export class FleetIdDto {
  @IsString()
  fleetId!: string;
}
