import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIMEZONES = [
  'Europe/Paris',
  'Europe/London',
  'Africa/Casablanca',
  'Asia/Dubai',
];

const COUNTRY_CODES = ['FR', 'MA', 'BE', 'LU', 'CH'];

class TimeSlotDto {
  @IsString() @Matches(TIME_REGEX) start!: string;
  @IsString() @Matches(TIME_REGEX) end!: string;
}

class CustomDateDto {
  @IsString() @Matches(DATE_REGEX) date!: string;
  @IsOptional() @IsBoolean() closed?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(3)
  @ValidateNested({ each: true }) @Type(() => TimeSlotDto)
  slots?: TimeSlotDto[];
}

export class UpsertVehicleScheduleDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  @IsIn(TIMEZONES)
  timezone?: string;

  @IsOptional() @IsBoolean() mondayEnabled?: boolean;
  @IsOptional() @IsString() @Matches(TIME_REGEX) mondayStart?: string;
  @IsOptional() @IsString() @Matches(TIME_REGEX) mondayEnd?: string;

  @IsOptional() @IsBoolean() tuesdayEnabled?: boolean;
  @IsOptional() @IsString() @Matches(TIME_REGEX) tuesdayStart?: string;
  @IsOptional() @IsString() @Matches(TIME_REGEX) tuesdayEnd?: string;

  @IsOptional() @IsBoolean() wednesdayEnabled?: boolean;
  @IsOptional() @IsString() @Matches(TIME_REGEX) wednesdayStart?: string;
  @IsOptional() @IsString() @Matches(TIME_REGEX) wednesdayEnd?: string;

  @IsOptional() @IsBoolean() thursdayEnabled?: boolean;
  @IsOptional() @IsString() @Matches(TIME_REGEX) thursdayStart?: string;
  @IsOptional() @IsString() @Matches(TIME_REGEX) thursdayEnd?: string;

  @IsOptional() @IsBoolean() fridayEnabled?: boolean;
  @IsOptional() @IsString() @Matches(TIME_REGEX) fridayStart?: string;
  @IsOptional() @IsString() @Matches(TIME_REGEX) fridayEnd?: string;

  @IsOptional() @IsBoolean() saturdayEnabled?: boolean;
  @IsOptional() @IsString() @Matches(TIME_REGEX) saturdayStart?: string;
  @IsOptional() @IsString() @Matches(TIME_REGEX) saturdayEnd?: string;

  @IsOptional() @IsBoolean() sundayEnabled?: boolean;
  @IsOptional() @IsString() @Matches(TIME_REGEX) sundayStart?: string;
  @IsOptional() @IsString() @Matches(TIME_REGEX) sundayEnd?: string;

  // V1.5 (Sprint K) — Multi-plages par jour. Si fourni, override start/end legacy.
  // Max 3 plages par jour.
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => TimeSlotDto)
  mondaySlots?: TimeSlotDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => TimeSlotDto)
  tuesdaySlots?: TimeSlotDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => TimeSlotDto)
  wednesdaySlots?: TimeSlotDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => TimeSlotDto)
  thursdaySlots?: TimeSlotDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => TimeSlotDto)
  fridaySlots?: TimeSlotDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => TimeSlotDto)
  saturdaySlots?: TimeSlotDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => TimeSlotDto)
  sundaySlots?: TimeSlotDto[];

  // V1.5 (Sprint K) — Pays jours feries (lib `date-holidays`).
  @IsOptional() @IsString() @IsIn(COUNTRY_CODES)
  countryCode?: string;

  // V1.5 (Sprint K) — Override ponctuel par date.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CustomDateDto)
  customDates?: CustomDateDto[];
}
