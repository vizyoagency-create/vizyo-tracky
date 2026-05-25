import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateVehicleGroupDto {
  @IsString()
  name!: string;

  /** Optionnel — requis pour les SUPER_ADMIN sans fleetId assigné. */
  @IsOptional()
  @IsUUID()
  fleetId?: string;
}

export class RenameVehicleGroupDto {
  @IsString()
  name!: string;
}

export class AddVehicleToGroupDto {
  @IsUUID()
  vehicleId!: string;
}
