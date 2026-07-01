import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Sprint 0.1 (+ instrumentation) — payload du report d'interruption du canal temps réel
 * envoyé par le client quand son socket WS reste coupé au-delà du seuil. Enrichi de
 * diagnostics (raison socket.io, transport, tentatives…) pour identifier la CAUSE RACINE
 * de la panne dans le centre d'alerte, au lieu d'un simple « X s sans live ».
 */
export class RealtimeIncidentDto {
  /** Durée d'interruption observée côté client, en millisecondes (borné à 24h). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400_000)
  downMs?: number;

  /** Raison socket.io de la coupure : 'ping timeout' | 'transport close' | 'transport error' | 'io server disconnect'… */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  reason?: string;

  /** Transport actif au moment de la coupure : 'websocket' | 'polling'. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  transport?: string;

  /** Dernier message de connect_error (handshake/refresh), tronqué. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  lastError?: string;

  /** Nombre de coupures (flaps) sur la session — un compteur élevé = instabilité. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  flaps?: number;

  /** false = le socket n'a JAMAIS réussi à se connecter (API/WS injoignable au login). */
  @IsOptional()
  @IsBoolean()
  everConnected?: boolean;
}
