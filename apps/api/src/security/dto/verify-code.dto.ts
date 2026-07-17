import { IsString, Matches } from 'class-validator';

export class VerifyCodeDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Le code doit contenir exactement 6 chiffres' })
  code!: string;
}
