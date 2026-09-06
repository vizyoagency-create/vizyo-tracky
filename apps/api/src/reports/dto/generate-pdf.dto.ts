import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CONDUCTEUR_AUCUN, FILTRE_CONDUCTEUR_REGEX, normaliserDriverIdDto } from '../../common/driver-scope';
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

  /**
   * ── LE FILTRE CONDUCTEUR SUIT LE DOCUMENT (F13) ──────────────────────────────────────
   *
   * Un gestionnaire filtré sur une personne qui clique « PDF » recevait le rapport de TOUTE
   * la société. Le fichier survit à l'écran qui l'a produit : il part par courriel, il
   * ressort d'un classeur six mois plus tard, et rien dedans ne disait qu'il décrivait une
   * autre population que celle qu'on regardait en cliquant.
   *
   * Deux formes, comme partout ailleurs : un identifiant de conducteur, ou `none` pour les
   * trajets SANS conducteur.
   *
   * ⚠️ `@Matches` porte l'EXPRESSION PARTAGÉE (`common/driver-scope`), celle que
   * `resolveDriverScope` applique ensuite : deux écritures séparées finiraient par diverger,
   * et c'est la plus permissive qui gagnerait — celle qui laisse passer.
   *
   * ⚠️ Le PDF DIT sur quel conducteur il porte (cf. `driverLabel`, rendu sous le nom de la
   * société). Un document filtré et muet est le même piège, déplacé dans un fichier.
   */
  // ⚠️ NORMALISÉ AVANT D'ÊTRE VALIDÉ. `@Matches` porte sur la valeur BRUTE et `@IsOptional()` ne
  // saute que `null`/`undefined` : sans cette ligne, `?driverId=` et `?driverId=%20none` étaient
  // refusés ICI (400) et acceptés par les trois routes qui lisent des `@Query()` bruts — le
  // tableau en panne au-dessus de compteurs qui décrivaient tranquillement une population.
  @Transform(({ value }) => normaliserDriverIdDto(value))
  @IsOptional()
  @Matches(FILTRE_CONDUCTEUR_REGEX, {
    message: `driverId doit être un identifiant de conducteur ou « ${CONDUCTEUR_AUCUN} ».`,
  })
  driverId?: string;
}
