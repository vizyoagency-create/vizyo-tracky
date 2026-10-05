import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  URGENCE_WHATSAPP_ECRANS,
  URGENCE_WHATSAPP_RETARD_MAX_S,
  type UrgenceWhatsappEcran,
} from '@vizyo/tracky-shared';

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

/**
 * Appui sur la ligne d'urgence WhatsApp. Entrée non fiable, affichée ensuite à un super-admin
 * (notification, centre d'activité) : l'écran est pris dans une liste FERMÉE, la plaque ne
 * porte que des caractères de plaque — aucun texte libre ne traverse.
 */
export class SignalUrgenceWhatsappBodyDto {
  @IsIn(URGENCE_WHATSAPP_ECRANS as readonly string[]) ecran!: UrgenceWhatsappEcran;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 -]{0,19}$/, { message: 'plaque invalide' })
  plaque?: string;

  /** Appui retenu pendant une panne, retransmis au retour de l'API — voir le DTO partagé. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(URGENCE_WHATSAPP_RETARD_MAX_S)
  retardS?: number;
}
