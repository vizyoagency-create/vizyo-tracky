import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import type { PdfReportSection } from '../report-pdf.service';

const SECTION_VALUES: PdfReportSection[] = ['kpi', 'alerts', 'topVehicles', 'trips'];

/**
 * Body du POST /api/reports/pdf — sert l'export PDF configurable depuis la
 * modal frontend (multi-selection vehicules + sections + caps).
 *
 * Backward compat : le GET /api/reports/pdf historique reste exposé pour les
 * clients qui ne sont pas encore migrés. Tous les champs hormis from/to sont
 * optionnels — en l'absence de filtre, le PDF reste un rapport flotte complet
 * avec toutes les sections (comportement legacy).
 */
export class GeneratePdfDto {
  @IsOptional()
  @IsUUID()
  fleetId?: string;

  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  /** Restreint le rapport a ces vehicules. Vide / absent => toute la flotte. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  vehicleIds?: string[];

  /** Sections a embarquer dans le PDF. Vide / absent => toutes les sections. */
  @IsOptional()
  @IsArray()
  @IsIn(SECTION_VALUES, { each: true })
  sections?: PdfReportSection[];

  /** Cap trajets detailles (default 30, max 500). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  maxTrips?: number;

  /** Cap top vehicules (default 10, max 50). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  topN?: number;
}
