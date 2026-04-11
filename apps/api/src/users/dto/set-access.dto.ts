import { IsArray, IsEnum, IsOptional, IsUUID } from 'class-validator';

export class SetUserAccessDto {
  @IsEnum(['ALL', 'CUSTOM'])
  type!: 'ALL' | 'CUSTOM';

  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  groupIds?: string[];

  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  vehicleIds?: string[];
}
