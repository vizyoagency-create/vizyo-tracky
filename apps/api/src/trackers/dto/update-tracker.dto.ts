import { IsOptional, IsString } from 'class-validator';

export class UpdateTrackerDto {
  @IsOptional()
  @IsString()
  model?: string;
}
