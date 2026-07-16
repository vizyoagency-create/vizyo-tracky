import { IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Corps du beacon public POST /api/partner/activity (LP / Maestroo).
 *
 * Entrée NON fiable et PUBLIQUE : bornée strictement. NB — un beacon
 * `navigator.sendBeacon` arrive souvent en `text/plain`, non parsé par le
 * ValidationPipe global : le contrôleur parse alors le corps brut et applique
 * la MÊME troncature côté service. Cette classe documente le contrat + valide
 * le chemin `application/json`.
 */
export class PartnerActivityDto {
  /** 'LP' | 'MAESTROO' | … — sinon l'origine est déduite de l'Origin/Referer. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  source?: string;

  /** Sémantique de l'événement (teaser_open, cta_click, teaser_close…). */
  @IsString()
  @MaxLength(60)
  action!: string;

  /** Cible / bouton. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  target?: string;

  /** Libellé lisible. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionId?: string;

  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}
