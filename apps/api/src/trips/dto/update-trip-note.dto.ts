import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * PATCH /trips/:id — mise a jour de la note libre.
 *
 * - `notes = null` ou chaine vide => effacer la note (et reset auteur).
 * - `notes` non vide => persister apres trim, max 500 chars.
 *
 * Le service capture aussi `notesUpdatedBy*` automatiquement depuis le User
 * authentifie ; le client n'a pas a fournir ces champs.
 */
export class UpdateTripNoteDto {
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La note est limitee a 500 caracteres.' })
  notes!: string | null;
}
