/**
 * Qualité GPS — diagnostics de ZONE MORTE (2026-08).
 *
 * Produits par l'agent qui tourne sur le poste : il croise les zones de perte de plusieurs
 * véhicules pour distinguer un LIEU mal couvert d'un BOÎTIER défaillant. Le diagnostic de boîtier
 * part au centre d'alerte (action datée) ; celui de lieu vient ici (qualification durable).
 */

export interface GpsZoneDiagnosticDto {
  id: string;
  createdAt: string;
  /** Dernier passage de l'agent qui a confirmé ce lieu — pas la date de découverte. */
  updatedAt: string;
  lat: number;
  lng: number;
  /** Commune ou lieu-dit, quand le géocodage l'a trouvé. */
  placeLabel: string | null;
  fleetId: string;
  fleetName: string | null;
  /** Plaques concernées. Dénormalisées : lisible même si un véhicule est archivé depuis. */
  vehicules: string[];
  episodes: number;
  etalementM: number;
  /** Ce que l'agent affirme, en une phrase. */
  constat: string;
  /** Ce qu'il faut faire. */
  recommandation: string;
  /** Renseigné dès qu'un humain a tranché. Tant que c'est null, le diagnostic attend. */
  traiteAt: string | null;
  traiteParEmail: string | null;
  note: string | null;
}

/** Marquer un diagnostic traité, avec ce qu'on a conclu. */
export interface TraiterZoneDto {
  /** Ce qui a été constaté sur place, ou pourquoi on classe sans suite. */
  note?: string;
  /** `false` rouvre un diagnostic classé par erreur. */
  traite?: boolean;
}
