import { IsString, IsUUID } from 'class-validator';

export class RecomputeTripsDto {
  @IsUUID() vehicleId!: string;
  @IsString() from!: string;
  @IsString() to!: string;
}
