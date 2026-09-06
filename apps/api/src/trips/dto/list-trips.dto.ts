import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { CONDUCTEUR_AUCUN, FILTRE_CONDUCTEUR_REGEX, normaliserDriverIdDto } from '../../common/driver-scope';

/**
 * Colonnes de tri acceptees par `GET /trips`. Liste FERMEE : elle est injectee
 * telle quelle dans le `orderBy` Prisma, donc toute valeur libre serait une
 * injection de champ. Alignee sur les colonnes triables du tableau Rapports
 * (`TripSortColumn` cote web).
 */
export const TRIP_SORT_COLUMNS = [
  'startedAt',
  'durationSeconds',
  'distanceMeters',
  'avgSpeed',
  'maxSpeed',
] as const;

export type TripSortColumn = (typeof TRIP_SORT_COLUMNS)[number];

export class ListTripsDto {
  @IsOptional() @IsUUID() vehicleId?: string;
  /** Liste de vehicleIds (séparés par virgule) — filtre groupe. Intersecté avec les accès. */
  @IsOptional() @IsString() vehicleIds?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() cursor?: string;
  /** Filtre société global (sélecteur super-admin). Ignoré pour un non-super. */
  @IsOptional() @IsUUID() fleetId?: string;
  /**
   * Filtre CONDUCTEUR — deux formes, et deux seulement :
   *
   *   - `driverId=<uuid>` → les trajets de cette personne ;
   *   - `driverId=none`   → les trajets SANS conducteur.
   *
   * La seconde n'est pas un raffinement : mesuré en production le 2026-09-05, 1 905 trajets
   * sur 1 956 chez « mh cars » n'ont aucun conducteur. C'est la liste que le gestionnaire
   * doit pouvoir isoler pour la corriger, et rien ne la lui donnait.
   *
   * ⚠️ Liste FERMÉE, comme `sortBy` au-dessus, et pour la même raison : la valeur finit dans
   * un `where` Prisma. `@Matches` porte l'EXPRESSION PARTAGÉE avec `resolveDriverScope`, qui
   * borne les routes lisant des `@Query()` bruts (`daily-summary`, `period-charts`,
   * `reports/stats`) — une seconde expression écrite ici aurait fini par diverger.
   */
  // ⚠️ NORMALISÉ AVANT D'ÊTRE VALIDÉ. `@Matches` porte sur la valeur BRUTE et `@IsOptional()` ne
  // saute que `null`/`undefined` : sans cette ligne, `?driverId=` et `?driverId=%20none` étaient
  // refusés ICI (400) et acceptés par les trois routes qui lisent des `@Query()` bruts — le
  // tableau en panne au-dessus de compteurs qui décrivaient tranquillement une population.
  @Transform(({ value }) => normaliserDriverIdDto(value))
  @IsOptional()
  @Matches(FILTRE_CONDUCTEUR_REGEX, {
    message: `driverId doit être un identifiant de conducteur ou « ${CONDUCTEUR_AUCUN} ».`,
  })
  driverId?: string;
  /**
   * Colonne de tri. Absent = `startedAt` (comportement historique inchangé).
   *
   * ⚠️ Le tri est fait en BASE, pas sur la page renvoyée : c'est tout l'intérêt.
   * Trier les 100 trajets déjà chargés donnait « le plus rapide des cent derniers »
   * en le présentant comme « le plus rapide de la période » (cf. trips.service.list).
   */
  @IsOptional() @IsIn(TRIP_SORT_COLUMNS as unknown as string[]) sortBy?: TripSortColumn;
  @IsOptional() @IsIn(['asc', 'desc']) sortDir?: 'asc' | 'desc';
  /**
   * Charge ALLÉGÉE pour les listes : sans `polyline` / `polylineMatched`, véhicule réduit
   * à l'identité (id, plaque, type, marque, modèle).
   *
   * Mesure en production (2026-09-02, mh cars, 100 trajets) : 430 Ko par page, dont 238 Ko
   * de polylignes et ~100 Ko de fiche véhicule répétée cent fois — pour un tableau qui
   * n'affiche ni l'une ni l'autre. Le tracé est demandé au moment du replay, trajet par
   * trajet (`GET /trips/:id`). Opt-in : les appelants qui dessinent (carte, historique)
   * gardent la charge complète.
   */
  @IsOptional() @IsIn(['1', 'true']) light?: string;
}
