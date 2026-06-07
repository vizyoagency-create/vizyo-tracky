import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/** Creation manuelle d'une SIM (fallback — le sync WhereverSIM importe le parc). */
export class CreateSimDto {
  @IsString()
  @Matches(/^\d{18,22}$/, { message: 'ICCID : 18 a 22 chiffres attendus' })
  iccid!: string;

  @IsOptional()
  @IsString()
  @Matches(/^(\+[1-9]\d{6,14})?$/, { message: 'msisdn : format E.164 (ex +33612345678) ou vide' })
  msisdn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsUUID()
  fleetId?: string;
}
