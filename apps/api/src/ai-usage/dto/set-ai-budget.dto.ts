import { IsNumber, Max, Min } from 'class-validator';

/** Réglage du budget IA mensuel (€). Super-admin. */
export class SetAiBudgetBodyDto {
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  monthlyBudgetEur!: number;
}
