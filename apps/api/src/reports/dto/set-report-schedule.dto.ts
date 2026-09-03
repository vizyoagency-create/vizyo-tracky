import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import type { FleetReportSection } from '@vizyo/tracky-shared';

const SECTION_VALUES: FleetReportSection[] = ['kpi', 'alerts', 'topVehicles', 'trips'];

/** Body du PUT /api/reports/schedule — réglage du rapport hebdomadaire d'une société. */
export class SetReportScheduleDto {
  @IsBoolean()
  enabled!: boolean;

  /** 1 = lundi … 7 = dimanche (Europe/Paris). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(7)
  weekday!: number;

  /** 0-23 (Europe/Paris). */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  hour!: number;

  /** Vide = administrateurs actifs de la société. */
  @IsArray()
  @ArrayMaxSize(10)
  @IsEmail({}, { each: true })
  recipients!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(SECTION_VALUES, { each: true })
  sections!: FleetReportSection[];

  /** Vide = tous les véhicules. */
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  vehicleIds!: string[];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxTrips!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  topN!: number;
}
