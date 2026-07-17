import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  /** « Rester connecté » : true (défaut) = cookies persistants (30j) ; false = cookies de session. */
  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}
