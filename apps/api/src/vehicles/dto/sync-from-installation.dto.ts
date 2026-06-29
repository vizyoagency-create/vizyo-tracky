import { ArrayNotEmpty, IsArray, IsIn } from 'class-validator';

/** Champs du véhicule recopiables depuis la tâche d'installation liée. */
const SYNCABLE_FIELDS = ['brand', 'model', 'energy'] as const;

/**
 * Sprint 10 — Corps de la synchro manuelle « depuis le planning ». Le client choisit
 * explicitement les champs à recopier (écrasement assumé, après aperçu côté UI).
 */
export class SyncFromInstallationDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(SYNCABLE_FIELDS as unknown as string[], { each: true })
  fields!: ('brand' | 'model' | 'energy')[];
}
