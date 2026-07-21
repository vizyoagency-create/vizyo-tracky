import { IsBoolean } from 'class-validator';

/** Lot 2 — déclaration d'usage mixte d'un véhicule (interrupteur de proportionnalité). */
export class SetMixedUseDto {
  @IsBoolean()
  enabled!: boolean;
}
