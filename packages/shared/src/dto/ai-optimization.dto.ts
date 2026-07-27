/**
 * Sprint 9 — Copilote IA d'optimisation de flotte. Types partagés API ↔ web.
 *
 * Principe directeur : l'IA PROPOSE (sortie structurée), l'app VALIDE/APPLIQUE.
 * AUCUNE de ces structures n'écrit en base : les propositions sont des DRY-RUN
 * jusqu'à acceptation humaine — capacité → écriture véhicule (perm vehicles_edit),
 * placement → flux de réservation S8 (request → confirm, gardes EXCLUDE/scoping).
 */

import type { ReservationCriteria } from './reservation.dto';

/** Métier d'une flotte — conditionne l'objectif d'optimisation de l'IA. */
export type FleetMetier = 'CHILDREN_TRANSPORT' | 'PARCELS' | 'RENTAL' | 'GENERIC';

export const FLEET_METIER_LABELS: Record<FleetMetier, string> = {
  CHILDREN_TRANSPORT: "Transport d'enfants",
  PARCELS: 'Transport de colis',
  RENTAL: 'Location',
  GENERIC: 'Générique',
};

/** Métier courant d'une flotte (lecture). */
export interface FleetMetierDto {
  fleetId: string;
  fleetName: string | null;
  metier: FleetMetier;
}

/** Réglage du métier d'une flotte (admins). `fleetId` requis pour un super-admin. */
export interface SetFleetMetierDto {
  fleetId?: string;
  metier: FleetMetier;
}

/* ===================== Capacité 1 — enrichissement de capacité ===================== */

/** Un véhicule en entrée du raisonnement capacité (construit côté API, déjà scopé). */
export interface AiCapacityVehicleInput {
  vehicleId: string;
  plate: string | null;
  type: string;
  brand: string | null;
  model: string | null;
  /** Énergie issue de l'InstallationTask liée, si disponible. */
  energy?: string | null;
  currentSeats?: number | null;
  currentChildSeats?: number | null;
  currentFeatures?: string[];
}

/** Payload envoyé à l'IA (assemblé côté serveur). */
export interface AiCapacityInputDto {
  metier: FleetMetier;
  fleetContext?: string | null;
  vehicles: AiCapacityVehicleInput[];
}

/** Proposition IA par véhicule (DRY-RUN — non écrite tant que non acceptée). */
export interface AiCapacityProposalDto {
  vehicleId: string;
  plate: string | null;
  model: string | null;
  seats: number | null;
  childSeats: number | null;
  features: string[];
  /** 0..1 — certitude IA (basse = variante ambiguë, à confirmer). */
  confidence: number;
  reasoning: string;
}

export interface AiCapacityResultDto {
  metier: FleetMetier;
  proposals: AiCapacityProposalDto[];
}

/** Requête front → API (capacité) : périmètre optionnel. */
export interface AiCapacitySuggestRequestDto {
  fleetId?: string;
  /** Sous-ensemble optionnel de véhicules à enrichir. */
  vehicleIds?: string[];
}

/** Application (humaine) d'un sous-ensemble de propositions → écrit les véhicules. */
export interface AiCapacityApplyItem {
  vehicleId: string;
  seats?: number | null;
  childSeats?: number | null;
  features?: string[];
}
export interface AiCapacityApplyDto {
  items: AiCapacityApplyItem[];
}

/* ===================== Capacité 2 — optimiseur de placement ===================== */

/** Un candidat (déjà filtré DISPONIBLE sur le créneau) en entrée du raisonnement. */
export interface AiPlacementCandidateInput {
  vehicleId: string;
  plate: string | null;
  seats: number | null;
  childSeats: number | null;
  features: string[];
  /** 0..1 — utilisation récente (bas = sous-utilisé → mutualisation). */
  utilizationRatio: number;
  underutilized: boolean;
  /** Prévision d'usage récurrent fort sur ce créneau (informe le tri, jamais bloquant). */
  forecastBusy: boolean;
  /** Énergie (DIESEL/ESSENCE/ELECTRIQUE/HYBRIDE/AUTRE) — sert à arbitrer le coût. */
  energy?: string | null;
  /** Coût/km estimé (€) — bas = mission moins chère : levier de RÉDUCTION DES COÛTS. */
  costPerKm?: number | null;
  /** Une maintenance est prévue peu après le créneau (à éviter si une alternative existe). */
  upcomingMaintenance?: boolean;
}

export interface AiPlacementRequestInput {
  startAt: string; // ISO
  endAt: string; // ISO
  title?: string;
  reason?: string;
  criteria?: ReservationCriteria;
}

/** Payload envoyé à l'IA (assemblé côté serveur). */
export interface AiPlacementInputDto {
  metier: FleetMetier;
  fleetContext?: string | null;
  /**
   * Avertissement de PÉRIMÈTRE, lu par le modèle en même temps que les données.
   *
   * Il existe parce que le prompt système décrit un « parc » : sans cette phrase, le modèle
   * suppose que `fleetSummary` couvre TOUS les véhicules de la société et raisonne sur un
   * parc plus large que celui qu'on lui a réellement montré (« mutualise plutôt vers le
   * véhicule inutilisé » — celui dont le boîtier est muet depuis 3 mois). Renseigné
   * UNIQUEMENT quand des véhicules ont vraiment été écartés : une phrase toujours présente
   * finirait par affirmer une exclusion qui n'a pas eu lieu.
   */
  scopeNote?: string;
  request: AiPlacementRequestInput;
  candidates: AiPlacementCandidateInput[];
  fleetSummary: {
    totalVehicles: number;
    underutilizedCount: number;
    avgUtilization: number;
    /** Coût/km le plus bas parmi les candidats (repère « au mieux » pour l'IA). */
    cheapestCostPerKm?: number | null;
    /**
     * Véhicules écartés du vivier car DORMANTS (boîtier muet depuis plus de 7 j). Exposé
     * DANS le résumé pour que l'IA sache que `totalVehicles` décrit le parc réellement
     * suivi, et non le parc complet : un ratio moyen calculé sur des véhicules
     * injoignables sous-estime l'usage réel et pousse à des conseils inapplicables.
     */
    dormantExcluded?: number;
  };
}

/** Proposition de placement (DRY-RUN — ne crée AUCUNE réservation). */
export interface AiPlacementProposalDto {
  vehicleId: string;
  plate: string | null;
  seats: number | null;
  childSeats: number | null;
  /** Énergie du véhicule (affichée dans la proposition). */
  energy?: string | null;
  /** Coût/km estimé (€) — transparence sur le levier coût. */
  costPerKm?: number | null;
  /** 0..1 — adéquation globale (1 = idéal). */
  score: number;
  reasoning: string;
}

export interface AiPlacementResultDto {
  slot: { startAt: string; endAt: string };
  proposals: AiPlacementProposalDto[];
  /** L'IA signale qu'aucun candidat ne couvre correctement le besoin. */
  noGoodMatch: boolean;
  notes?: string | null;
  /** Transparence : véhicules écartés AVANT le raisonnement IA (capacité inconnue). */
  excludedUnknownCapacity?: number;
  /** Transparence : véhicules écartés car immobilisés (incident/maintenance bloquant). */
  excludedImmobilized?: number;
  /**
   * Transparence : véhicules écartés car DORMANTS (boîtier muet depuis plus de 7 j).
   *
   * Compté et remonté à l'UI parce qu'un exploitant qui voit « 3 véhicules proposés » sur un
   * parc de 5 doit pouvoir répondre « et les 2 autres ? ». Un chiffre client ne baisse jamais
   * en silence : le véhicule n'est pas supprimé, il reste consultable partout, seule sa
   * participation à CETTE proposition cesse — et il y revient seul dès la première trame reçue.
   */
  excludedDormant?: number;
  /** Coût € estimé de CET appel IA (transparence ; le budget mensuel vit côté admin). */
  aiCostEur?: number | null;
}

/** Requête front → API (placement) : le serveur construit les candidats via suggest(). */
export interface AiPlacementSuggestRequestDto {
  /** Société ciblée. REQUIS pour un super-admin (sinon 400) — évite d'agréger toutes
   *  les flottes dans le raisonnement et de perdre le métier. Ignoré pour un non-SA. */
  fleetId?: string;
  startAt: string; // ISO
  endAt: string; // ISO
  title?: string;
  reason?: string;
  criteria?: ReservationCriteria;
}
