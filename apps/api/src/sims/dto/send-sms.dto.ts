import { IsString, MaxLength, MinLength } from 'class-validator';

/** Envoi d'un SMS vers la SIM (WhereverSIM sendSms). */
export class SendSimSmsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  text!: string;
}
