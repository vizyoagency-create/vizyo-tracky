import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Sprint 0.1 — payload du report d'interruption du canal temps réel envoyé par
 * le client quand son socket WS reste coupé au-delà du seuil.
 */
export class RealtimeIncidentDto {
  /** Durée d'interruption observée côté client, en millisecondes (borné à 24h). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400_000)
  downMs?: number;
}
