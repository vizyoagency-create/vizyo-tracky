import { IsInt, Min, ValidateIf } from 'class-validator';

/** Plafond data mensuel (octets). `null` = illimite (0 cote WhereverSIM). */
export class SetSimDataLimitDto {
  @ValidateIf((o: SetSimDataLimitDto) => o.bytes !== null)
  @IsInt()
  @Min(0)
  bytes!: number | null;
}
