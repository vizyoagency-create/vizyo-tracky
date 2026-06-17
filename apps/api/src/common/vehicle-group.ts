/**
 * Helpers réutilisables pour charger + aplatir le GROUPE (unique de-facto) d'un
 * véhicule dans n'importe quel service (trackers, sims, alerts, trips,
 * surveillance, reports…). Centralise ce que `VehiclesService` faisait en privé,
 * pour que le groupe soit exposé de façon cohérente partout sans dupliquer la
 * forme de l'include Prisma.
 *
 * Décision produit : 1 groupe/véhicule, mais le schéma reste M2M
 * (VehicleGroupAssignment) ; `take: 1` + tri par nom = résultat déterministe
 * même si une donnée legacy porte >1 assignation.
 */

/** Référence groupe attachée aux réponses liées à un véhicule. */
export type VehicleGroupRef = { id: string; name: string } | null;

/**
 * Include Prisma à spreader sur une requête `vehicle` (ou une relation vehicle) :
 *   include: { ...VEHICLE_GROUP_INCLUDE }
 *   include: { vehicle: { include: { ...VEHICLE_GROUP_INCLUDE } } }
 */
export const VEHICLE_GROUP_INCLUDE = {
  groups: {
    select: { group: { select: { id: true, name: true } } },
    orderBy: { group: { name: 'asc' } },
    take: 1,
  },
} as const;

/** Select équivalent (quand on est dans un `select` et non un `include`). */
export const VEHICLE_GROUP_SELECT = {
  groups: {
    select: { group: { select: { id: true, name: true } } },
    orderBy: { group: { name: 'asc' } },
    take: 1,
  },
} as const;

/** Extrait `group: {id,name} | null` depuis la jointure `groups[0].group`. */
export function vehicleGroupOf(
  v: { groups?: { group: { id: string; name: string } }[] | null } | null | undefined,
): VehicleGroupRef {
  return v?.groups?.[0]?.group ?? null;
}

/** Aplatit `{ ...vehicle, groups }` en `{ ...vehicle, group }`. */
export function flattenVehicleGroup<
  T extends { groups?: { group: { id: string; name: string } }[] | null },
>(v: T): Omit<T, 'groups'> & { group: VehicleGroupRef } {
  const { groups, ...rest } = v;
  return { ...rest, group: groups?.[0]?.group ?? null };
}
