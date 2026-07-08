import { IsArray, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UpsertVehicleScheduleDto } from './upsert-vehicle-schedule.dto';

/**
 * Demande CDEF (2026-07) — Bulk « activer tout + poser des horaires d'un coup ».
 *
 * La config d'horaires réutilise EXACTEMENT `UpsertVehicleScheduleDto` (mêmes champs,
 * même validation), appliquée à chaque véhicule ciblé via le MÊME chemin d'écriture que
 * la fiche véhicule (`VehicleSchedulesService.upsert`) → aucune divergence possible.
 */
export class BulkScheduleApplyDto {
  /**
   * Véhicules ciblés. Omis = TOUS les véhicules du périmètre de l'appelant sur lesquels il
   * a la permission `schedules_manage` (résolue par véhicule côté service).
   */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  vehicleIds?: string[];

  @ValidateNested()
  @Type(() => UpsertVehicleScheduleDto)
  schedule!: UpsertVehicleScheduleDto;
}
