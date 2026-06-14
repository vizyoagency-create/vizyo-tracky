import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Un event de tracking (validation côté serveur — entrée non fiable). */
export class TrackEventDto {
  @IsString()
  @MaxLength(40)
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  route?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  routeLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  target?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  at?: string;
}

export class ActivityBatchDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TrackEventDto)
  events!: TrackEventDto[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  deviceType?: string;
}
