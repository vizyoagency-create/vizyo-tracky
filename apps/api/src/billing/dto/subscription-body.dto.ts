import { TrackyFormule, TrackyPlan } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** D4 — corps de mise à jour de l'abonnement d'une flotte (admin « Abonnements & tarifs »). */
export class UpsertSubscriptionDto {
  @IsEnum(TrackyPlan)
  plan!: TrackyPlan;

  @IsEnum(TrackyFormule)
  formule!: TrackyFormule;

  @IsOptional() @IsBoolean()
  optLive?: boolean;

  @IsOptional() @IsBoolean()
  optMicro?: boolean;

  @IsOptional() @IsBoolean()
  optAgent?: boolean;

  @IsOptional() @IsIn(['90j', '1an', '2ans', '3ans'])
  retentionKey?: string;

  @IsOptional() @IsBoolean()
  isComp?: boolean;

  /** Prix négocié €/véhicule/an (null = grille). */
  @IsOptional() @IsInt() @Min(0) @Max(100_000)
  customPriceEurYear?: number | null;

  @IsOptional() @IsString() @MaxLength(1000)
  notes?: string | null;
}

/** Phase 3 — corps de mise à jour de la grille tarifaire (validation structurelle côté service). */
export class UpdatePricingGridDto {
  @IsObject()
  grid!: Record<string, unknown>;
}
