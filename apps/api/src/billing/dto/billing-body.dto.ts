import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

/** Régler le prix de l'option IA (super-admin). */
export class SetBillingPriceBodyDto {
  @IsInt()
  @Min(0)
  aiUnitAmountEurCents!: number;

  @IsOptional()
  @IsIn(['per_vehicle', 'flat'])
  aiPricingUnit?: 'per_vehicle' | 'flat';
}

/** Offrir / révoquer l'IA d'une société sans paiement (super-admin, statut COMP). */
export class SetCompBodyDto {
  @IsUUID()
  fleetId!: string;

  @IsBoolean()
  enabled!: boolean;
}

/** Optionnel : cibler une société (super-admin). Un fleet-admin est forcé à la sienne. */
export class BillingFleetBodyDto {
  @IsOptional()
  @IsString()
  fleetId?: string;
}
