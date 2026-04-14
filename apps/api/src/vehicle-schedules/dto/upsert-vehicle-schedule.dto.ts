import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIMEZONES = [
  'Europe/Paris',
  'Europe/London',
  'Africa/Casablanca',
  'Asia/Dubai',
];

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
}
