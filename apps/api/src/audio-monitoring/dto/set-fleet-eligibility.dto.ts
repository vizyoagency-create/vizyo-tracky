import { IsBoolean } from 'class-validator';

/**
 * Sprint 4 — Corps de l'ÉLIGIBILITÉ audio (N1, super-admin/prestataire). Décide si une
 * flotte est autorisée à voir/activer le « Mode assistance ». `eligible:false` ⇒ tout OFF
 * pour la flotte (cascade : le consentement N2 assistanceEnabled est aussi remis à false).
 */
export class SetFleetEligibilityDto {
  @IsBoolean()
  eligible!: boolean;
}
