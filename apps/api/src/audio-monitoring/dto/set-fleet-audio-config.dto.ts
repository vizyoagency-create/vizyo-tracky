import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Sprint 4 — Corps du CONSENTEMENT « Mode assistance » (N2, fleet-admin) de l'écoute
 * audio PAR FLOTTE (garde-fous #1 + #5). Activer (`assistanceEnabled:true`) EXIGE
 * `attestation:true` (le service rejette sinon par BadRequestException #5) ET que la
 * flotte soit déjà ÉLIGIBLE (N1 superAdminEnabled posé par le prestataire, sinon 403).
 * `attestationVersion` trace la version du texte d'attestation accepté.
 */
export class SetFleetAudioConfigDto {
  @IsBoolean()
  assistanceEnabled!: boolean;

  /**
   * #5 — case « j'atteste, au nom de mon organisation, avoir informé
   * occupants/conducteurs + posé la signalétique ». Obligatoire à l'activation.
   */
  @IsOptional()
  @IsBoolean()
  attestation?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  attestationVersion?: string;
}
