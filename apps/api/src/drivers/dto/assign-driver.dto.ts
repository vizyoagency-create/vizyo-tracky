import { IsOptional, IsUUID, ValidateIf } from 'class-validator';

/**
 * Body pour les endpoints PATCH /vehicles/:id/driver et PATCH /trips/:id/driver.
 * `driverId = null` => retirer l'assignation. UUID valide => assigner.
 */
export class AssignDriverDto {
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsUUID()
  driverId!: string | null;
}
