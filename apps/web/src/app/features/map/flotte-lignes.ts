import {
  formatSilenceLabel,
  getVehicleConnectivityState,
  type VehicleConnectivityState,
} from '@vizyo/tracky-shared';

/** Les quatre puces de la feuille flotte (planche « Carte + flotte »). */
export type FiltreFlotte = 'tous' | 'route' | 'arret' | 'hors-ligne';
/** L'état affiché d'un véhicule dans la liste. Dérivé, jamais saisi. */
export type EtatFlotte = 'route' | 'arret' | 'hors-ligne';

export interface LigneFlotte {
  vehicleId: string;
  trackerId: string | null;
  plate: string;
  modele: string;
  etat: EtatFlotte;
  /** `null` hors direct : une vitesse périmée ne se montre pas (incident FS-253). */
  vitesse: number | null;
  connectivite: VehicleConnectivityState;
  silence: string | null;
}

/** Ce dont la ligne a besoin, et rien de plus — sous-ensemble de `VehicleSnapshotDto`. */
export interface EntreeFlotte {
  vehicleId: string;
  plate: string;
  brand?: string | null;
  model?: string | null;
  trackerId: string | null;
  lastSeenAt: string | null;
  lastPositionAt?: string | null;
  lastNoFixAt?: string | null;
  lastIgnition?: boolean | null;
  lastSpeedKmh?: number | null;
}

const RANG: Record<EtatFlotte, number> = { route: 0, arret: 1, 'hors-ligne': 2 };

/**
 * Construit les lignes de la feuille flotte.
 *
 * ⚠️ LA RÈGLE QUE CE FICHIER EXISTE POUR TENIR : **une vitesse ne s'affiche que si
 * le boîtier est en direct** (`ONLINE`). C'est l'incident FS-253 — un véhicule garé
 * dans un parking souterrain depuis cinq jours affichait une pastille verte « contact
 * mis », parce que sa dernière trame, vieille de cinq jours, disait `ignition: true`.
 * Hors direct, la vitesse est un SOUVENIR : on nomme l'état et depuis quand, on ne
 * recopie pas un chiffre.
 *
 * L'état vient de `getVehicleConnectivityState`, la même dérivation que les marqueurs
 * de la carte et que `app-connectivity-badge` : sans cela la liste annoncerait
 * « 72 km/h » là où la carte affiche une pastille grise.
 *
 * `PARKED` est un ARRÊT, pas une panne : un boîtier qui se met en veille contact
 * coupé est un véhicule garé, et le dire « hors ligne » inquiéterait pour rien.
 */
export function construireLignesFlotte(
  vehicules: readonly EntreeFlotte[],
  vitesseEnDirect: (trackerId: string) => number | undefined,
  maintenant: number = Date.now(),
): LigneFlotte[] {
  return vehicules
    .map((v) => {
      const connectivite = getVehicleConnectivityState(
        {
          trackerId: v.trackerId,
          lastSeenAt: v.lastSeenAt,
          lastPositionAt: v.lastPositionAt ?? null,
          lastNoFixAt: v.lastNoFixAt,
          lastIgnition: v.lastIgnition,
        },
        maintenant,
      );
      const enDirect = connectivite === 'ONLINE';
      const vitesse = enDirect
        ? Math.round((v.trackerId ? vitesseEnDirect(v.trackerId) : undefined) ?? v.lastSpeedKmh ?? 0)
        : null;
      const etat: EtatFlotte =
        enDirect || connectivite === 'PARKED'
          ? (vitesse ?? 0) > 0
            ? 'route'
            : 'arret'
          : 'hors-ligne';
      return {
        vehicleId: v.vehicleId,
        trackerId: v.trackerId,
        plate: v.plate,
        // Ce qu'on sait avec certitude. La planche montre « Renault Clio · A61
        // sortie 17 » : le libellé de lieu n'existe dans aucun DTO, on ne l'invente pas.
        modele: [v.brand, v.model].filter(Boolean).join(' ') || 'Modèle non renseigné',
        etat,
        vitesse,
        connectivite,
        silence: formatSilenceLabel(v.lastSeenAt, maintenant),
      };
    })
    .sort((a, b) => RANG[a.etat] - RANG[b.etat] || a.plate.localeCompare(b.plate));
}

/** Compteurs des puces — sur la liste ENTIÈRE, jamais sur la vue filtrée. */
export function compteursFlotte(lignes: readonly LigneFlotte[]): Record<FiltreFlotte, number> {
  return {
    tous: lignes.length,
    route: lignes.filter((v) => v.etat === 'route').length,
    arret: lignes.filter((v) => v.etat === 'arret').length,
    'hors-ligne': lignes.filter((v) => v.etat === 'hors-ligne').length,
  };
}

export function filtrerFlotte(lignes: readonly LigneFlotte[], filtre: FiltreFlotte): LigneFlotte[] {
  return filtre === 'tous' ? [...lignes] : lignes.filter((v) => v.etat === filtre);
}
