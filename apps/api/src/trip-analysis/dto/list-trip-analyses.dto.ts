import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * Corps de `POST /trip-analysis/by-trips` — les trajets dont on veut l'analyse.
 *
 * ⚠️ POST pour une LECTURE, volontairement : une page de rapports affiche jusqu'à
 * 100 trajets, soit ~3 700 caractères d'UUID en query string. Ça passe encore, puis ça
 * casse silencieusement derrière un proxy à la limite d'URI près — un mode de panne
 * dépendant de l'infra, invisible en développement. Le corps de requête n'a pas ce
 * problème.
 */
export class ListTripAnalysesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  // ⚠️ Pas `IsUUID('4')` : un seul identifiant d'une autre version ferait échouer TOUT
  // le lot en 400, et la colonne « Analyse » redeviendrait vide sans explication. Le
  // reste du code (ex. `ListTripsDto.vehicleId`) accepte déjà n'importe quelle version.
  @IsUUID(undefined, { each: true })
  tripIds!: string[];
}
