import { IsOptional, IsString, IsUUID } from 'class-validator';

export class ListTripsDto {
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() cursor?: string;
}
