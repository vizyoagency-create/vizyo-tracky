import { IsString, IsUUID } from 'class-validator';

export class CreateVehicleGroupDto {
  @IsString()
  name!: string;
}

export class RenameVehicleGroupDto {
  @IsString()
  name!: string;
}

export class AddVehicleToGroupDto {
  @IsUUID()
  vehicleId!: string;
}
