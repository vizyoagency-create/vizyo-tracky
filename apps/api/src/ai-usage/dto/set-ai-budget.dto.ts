import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/** Réglage du budget IA mensuel (€) et, optionnellement, du taux USD→€. Super-admin. */
export class SetAiBudgetBodyDto {
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  monthlyBudgetEur!: number;

  /**
   * Taux USD→€ appliqué à tous les montants en euros (C3 point 4 : 0,92 en dur jusqu'au
   * 05/09, marché ≈ 0,86). Bornes 0,5..1,5 : au-delà c'est une faute de frappe, pas un taux
   * de change. Absent = inchangé.
   */
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(1.5)
  usdToEurRate?: number;
}
