import { IsBoolean, IsEmail, IsHexColor, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDriverDto {
  @IsString()
  @MinLength(1, { message: 'Prénom requis.' })
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @MinLength(1, { message: 'Nom requis.' })
  @MaxLength(80)
  lastName!: string;

  /**
   * Format E.164 attendu cote app (+33612345678) mais validation laxe ici :
   * la SIM/Twilio gateway fera la verif stricte au moment d'envoyer.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @IsEmail({}, { message: 'Email invalide.' })
  @MaxLength(255)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  licenseNumber?: string | null;

  @IsOptional()
  @IsHexColor({ message: 'Couleur hex invalide (ex: #10E0A0).' })
  color?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
