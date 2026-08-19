import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/** Poser une question. `conversationId` absent = nouvelle conversation. */
export class AskAssistanceBodyDto {
  @IsString()
  @MinLength(1)
  // Borné DÈS l'entrée : un message de 200 000 caractères se paie en tokens avant même
  // qu'on ait décidé s'il méritait une réponse.
  @MaxLength(2000)
  message!: string;

  @IsOptional() @IsUUID() conversationId?: string;
}

/** Demander un rappel humain. */
export class RappelUrgentBodyDto {
  @IsOptional() @IsString() @MaxLength(400) motif?: string;
}

/** Marquer une conversation relue (admin). */
export class ReviewAssistanceBodyDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsBoolean() clore?: boolean;
}

/** Réponse d'un conseiller humain (admin). */
export class AdminReplyBodyDto {
  @IsString() @MinLength(1) @MaxLength(2000) message!: string;
}
