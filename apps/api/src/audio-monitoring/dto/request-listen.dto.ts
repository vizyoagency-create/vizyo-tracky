import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Sprint 4 — Corps du déclenchement d'écoute. Le **motif est obligatoire**
 * (garde-fou #4) : aucune écoute « anonyme ». Le service revalide aussi le motif
 * trimé non vide (défense en profondeur), mais le DTO rejette déjà l'absence.
 */
export class RequestListenDto {
  @IsString()
  @IsNotEmpty({ message: 'motif obligatoire' })
  @MaxLength(500)
  reason!: string;
}
