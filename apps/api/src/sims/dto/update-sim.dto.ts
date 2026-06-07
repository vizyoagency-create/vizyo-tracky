import { IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';

/** Edition des champs Tracky d'une SIM + allocation flotte (SUPER_ADMIN). */
export class UpdateSimDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  /** UUID d'une flotte, ou `null` pour desallouer (retour au stock central). */
  @IsOptional()
  @ValidateIf((o: UpdateSimDto) => o.fleetId !== null)
  @IsUUID()
  fleetId?: string | null;
}
