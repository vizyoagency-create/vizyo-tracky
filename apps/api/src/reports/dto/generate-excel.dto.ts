import { IsDateString, IsOptional, IsUUID } from 'class-validator';

/**
 * Sprint 5 — Body du POST /api/reports/excel.
 *
 * L'export Excel « soigné » couvre UN VÉHICULE ou TOUT UN PÉRIMÈTRE (société, groupe)
 * sur une période → un classeur .xlsx mis en forme. Le périmètre utilisateur est vérifié
 * côté service (ReportExcelService) : ce qui est demandé est toujours intersecté avec les
 * véhicules réellement accessibles à l'appelant, sinon 403.
 */
export class GenerateExcelDto {
  /**
   * ── L'EXCEL N'EXISTAIT QUE PAR VÉHICULE ────────────────────────────────────────────
   *
   * Un gestionnaire qui voulait le mois de son parc devait lancer quarante exports et les
   * recoller à la main, ou se rabattre sur le CSV brut. `vehicleId` devient donc FACULTATIF :
   * absent, le classeur porte tout le périmètre demandé, avec une feuille de synthèse par
   * véhicule en tête.
   *
   * ⚠️ Ces trois champs ne DESSERRENT rien : le service intersecte toujours avec les
   * véhicules réellement accessibles à l'appelant.
   */
  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  /** Restreint à un groupe de véhicules. Ignoré si `vehicleId` est fourni. */
  @IsOptional()
  @IsUUID()
  groupId?: string;

  /** Société visée — un super-administrateur doit pouvoir la désigner. */
  @IsOptional()
  @IsUUID()
  fleetId?: string;

  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}
