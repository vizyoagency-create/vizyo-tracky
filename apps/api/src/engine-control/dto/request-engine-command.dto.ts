import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { EngineAction } from '@prisma/client';

export class RequestEngineCommandDto {
  @IsEnum(EngineAction, { message: 'action doit être CUT ou RESTORE' })
  action!: EngineAction;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** Si true, désactive le schedule du véhicule avant d'envoyer la commande. */
  @IsOptional()
  @IsBoolean()
  disableSchedule?: boolean;

  /** Clé stable d'un clic métier : les retries HTTP renvoient la même intention. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;
}
