import { IsString, MaxLength } from 'class-validator';

/**
 * Import par lot : une SIM par ligne, separateurs `, ; <tab>` ou espaces.
 * 1er token = ICCID (requis), 2e = MSISDN (optionnel), reste = label.
 */
export class BulkCreateSimDto {
  @IsString()
  @MaxLength(100_000)
  raw!: string;
}
