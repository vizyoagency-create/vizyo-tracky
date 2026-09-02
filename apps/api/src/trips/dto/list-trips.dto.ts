import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

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
