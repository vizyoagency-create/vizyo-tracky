import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class SetPrivacyModeDto {
  @IsBoolean()
  enabled!: boolean;

  /** Note facultative (traçabilité) — comme la modal « couper le moteur ». */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}
