import { ArrayUnique, IsArray, IsOptional, IsUUID } from 'class-validator';

/**
 * #27 — Body de POST /geofences/:id/vehicles. Remplace l'interface inline
 * `{ vehicleIds: string[] }` (NON validee) afin que le ValidationPipe global
 * (whitelist + forbidNonWhitelisted) rejette tout input malforme : un payload
 * `vehicleIds` non-array ou contenant des non-UUID provoquait un 500 (ou un wipe
 * silencieux des cibles). `vehicleIds` absent = mode global (toutes les cibles
 * retirees), conserve via `?? []` cote controleur.
 */
export class SetVehicleTargetsDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  vehicleIds?: string[];
}
