import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Sprint 4 — Corps de l'activation/désactivation de l'écoute audio PAR FLOTTE
 * (garde-fous #1 + #5). Activer (`enabled:true`) EXIGE `attestation:true` (le
 * service rejette sinon par BadRequestException #5). `attestationVersion` trace
 * la version du texte d'attestation accepté.
 */
export class SetFleetAudioConfigDto {
  @IsBoolean()
  enabled!: boolean;

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
