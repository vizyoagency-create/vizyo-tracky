import { IsUUID, ValidateIf } from 'class-validator';

/**
 * Sprint 1 (Fondation Groupes) — définit le groupe (single) d'un véhicule.
 * `groupId: null` = retirer le véhicule de son groupe (« sans groupe »).
 * Décision produit : 1 groupe/véhicule (schéma M2M conservé, assignation = replace).
 */
export class SetVehicleGroupDto {
  @ValidateIf((o) => o.groupId !== null)
  @IsUUID()
  groupId!: string | null;
}
