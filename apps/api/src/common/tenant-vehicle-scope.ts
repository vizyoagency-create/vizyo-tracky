import { UserRole } from '@prisma/client';
import { resolveTenantScope } from './tenant-scope';

/**
 * LE PIÈGE DU SENTINEL `'ALL'` — et la clause qui le désamorce.
 *
 * ── L'incident (2026-08-02) ──────────────────────────────────────────────────────────
 * Un FLEET_ADMIN de la flotte « cdef31 » voyait, en cliquant sur une station-service de
 * la carte, les véhicules de « mh cars ». Fuite de données entre deux clients.
 *
 * La cause n'est pas un `where` oublié : c'est une AMBIGUÏTÉ DE VOCABULAIRE.
 * `VehicleAccessService.getAccessibleVehicleIds()` renvoie `'ALL'` pour un FLEET_ADMIN.
 * Dans l'intention, cela veut dire « tous les véhicules **de sa flotte** » — il n'a pas
 * de restriction par véhicule. Plusieurs appelants l'ont lu comme « aucun filtre » :
 *
 *     const where = accessible === 'ALL'
 *       ? (fleetId ? { fleetId } : {})   // ← `{}` = TOUTE LA BASE
 *       : { vehicleId: { in: accessible } };
 *
 * …et comme les contrôleurs ne transmettent `fleetId` qu'aux SUPER_ADMIN (à juste titre :
 * un client ne choisit pas la flotte qu'il consulte), la branche `{}` s'appliquait à tous
 * les FLEET_ADMIN. Le filtre le plus permissif était atteint par le chemin le plus courant.
 *
 * ── La règle ────────────────────────────────────────────────────────────────────────
 * **`'ALL'` ne doit JAMAIS produire une absence de clause.** Seul un SUPER_ADMIN a un
 * périmètre réellement illimité ; pour tout autre rôle, `'ALL'` se traduit par sa flotte.
 * Un compte sans flotte ne matche RIEN (fail-closed) : c'est le seul défaut acceptable,
 * parce qu'il est visible immédiatement, alors qu'une fuite est silencieuse.
 *
 * ⚠️ Ce module renvoie une clause portant `fleetId` et/ou `vehicleId`. Il ne s'applique
 * donc qu'aux tables qui portent CES colonnes (`trip_fuel_stops`, `trip_analyses`,
 * `positions`…). Pour une table sans `fleetId`, il faut joindre — ne pas contourner.
 */

/** Clause de cloisonnement, prête à étaler dans un `where` Prisma. */
export type TenantVehicleWhere =
  /** SUPER_ADMIN sans filtre de société : le seul cas légitime d'absence de clause. */
  | Record<string, never>
  /** Périmètre par société. */
  | { fleetId: string }
  /** Périmètre par véhicules (accès restreint), ou aucun véhicule accessible. */
  | { vehicleId: { in: string[] } };

/**
 * Identifiant impossible, utilisé pour matcher ZÉRO ligne.
 *
 * Un tableau vide dans un `in` Prisma matche zéro ligne lui aussi, mais il rend la
 * requête triviale à mal relire (« in: [] », est-ce voulu ?). Une valeur explicite dit
 * l'intention : on veut zéro résultat, ce n'est pas un oubli.
 */
export const NO_VEHICLE = '00000000-0000-0000-0000-000000000000';

/**
 * Traduit le périmètre d'un utilisateur en clause `where` sûre.
 *
 * @param accessible  ce que renvoie `getAccessibleVehicleIds()` : `'ALL'` ou la liste.
 * @param user        rôle + flotte, pour désambiguïser `'ALL'`.
 * @param requestedFleetId  société demandée — **honorée pour un SUPER_ADMIN seulement**.
 *                          Pour tout autre rôle elle est ignorée : c'est ce paramètre,
 *                          transmis depuis la query string, qui permettrait sinon à un
 *                          client de consulter la flotte d'un autre.
 */
export function tenantVehicleWhere(
  accessible: string[] | 'ALL',
  user: { role: UserRole; fleetId: string | null | undefined },
  requestedFleetId?: string,
): TenantVehicleWhere {
  // Périmètre restreint par véhicule : il est déjà borné, et il l'emporte sur la société
  // (une règle d'accès plus fine ne doit pas être élargie par le cloisonnement de flotte).
  if (accessible !== 'ALL') {
    return { vehicleId: { in: accessible.length > 0 ? accessible : [NO_VEHICLE] } };
  }

  const scope = resolveTenantScope(user);
  if (scope.mode === 'ALL') {
    // SUPER_ADMIN : illimité, sauf s'il a choisi une société dans le sélecteur.
    return requestedFleetId ? { fleetId: requestedFleetId } : {};
  }
  if (scope.mode === 'FLEET') {
    // ⚠️ LA CORRECTION. Avant, on tombait ici sur `{}`.
    return { fleetId: scope.fleetId };
  }
  // Ni super-admin, ni flotte : aucune donnée. Fail-closed.
  return { vehicleId: { in: [NO_VEHICLE] } };
}
