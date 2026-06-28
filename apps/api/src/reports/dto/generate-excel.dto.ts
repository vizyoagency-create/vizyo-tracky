import { IsDateString, IsUUID } from 'class-validator';

/**
 * Sprint 5 — Body du POST /api/reports/excel.
 *
 * L'export Excel « soigné » est **par véhicule** (1 véhicule + période → 1
 * classeur .xlsx mis en forme). Le périmètre utilisateur est vérifié côté
 * service (ReportExcelService) : le `vehicleId` doit appartenir au périmètre
 * accessible de l'appelant ET à sa flotte, sinon 403.
 */
export class GenerateExcelDto {
  @IsUUID()
  vehicleId!: string;

  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}
