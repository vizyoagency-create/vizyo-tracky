import { VehicleOutOfServiceReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Déclarer (ou lever) l'état HORS SERVICE d'un véhicule — réservé au super-admin.
 *
 * `reason: null` remet le véhicule en service. Ce n'est pas un détail de forme : c'est la seule
 * manière de sortir de l'état, et elle doit être aussi simple que d'y entrer. Un interrupteur
 * qu'on ne sait pas éteindre finit par ne plus jamais être allumé.
 */
export class SetOutOfServiceDto {
  /**
   * `null` (ou absent) = remise en service. Une valeur = mise hors service pour ce motif.
   *
   * ⚠️ `ValidateIf` et non `IsOptional` : `IsOptional` laisserait passer n'importe quoi dès lors
   *    que la valeur est `null` OU `undefined`, alors qu'on veut valider strictement l'enum dans
   *    tous les autres cas — y compris une chaîne vide ou un motif inventé côté client.
   */
  @ValidateIf((_, valeur) => valeur !== null && valeur !== undefined)
  @IsEnum(VehicleOutOfServiceReason, {
    message: 'Motif inconnu : accident, boîtier débranché ou immobilisation.',
  })
  reason?: VehicleOutOfServiceReason | null;

  /** Précision libre — ce que le motif seul ne dit pas (date de l'accident, n° de dossier…). */
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'La note est limitée à 500 caractères.' })
  note?: string;
}
