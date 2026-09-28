/**
 * Sprint 8 (Palier B) — Réservations de véhicules (créneau + critères) portées par le modèle
 * d'événement S7 (`VehicleEvent` type=RESERVATION). Flux Demande → validation :
 *   REQUESTED (déposée, non bloquant) → CONFIRMED (ferme, bloquant) → IN_PROGRESS → DONE ;
 *   CANCELLED couvre refus/annulation. La réservation est représentée par `VehicleEventDto`
 *   (metadata porte demandeur + critères + motif). Types partagés API ↔ web.
 */

/**
 * Sièges auto (2026-09-28) — deux types, JAMAIS interchangeables : un enfant « bébé » ne peut pas
 * aller dans un siège « enfant », ni l'inverse. Ils ne sont pas une caractéristique du véhicule
 * mais un STOCK de la société (réglé dans « Paramètres de l'agenda »), installé dans le véhicule
 * retenu ; c'est le stock, sur le créneau, qui borne les réservations.
 */
export type ChildSeatType = 'BABY' | 'CHILD';
export const CHILD_SEAT_LABELS: Record<ChildSeatType, string> = { BABY: 'Bébé', CHILD: 'Enfant' };

/** Un compte par type de siège. */
export interface ChildSeatCounts {
  baby: number;
  child: number;
}

/** Le stock d'une société. */
export interface ChildSeatStockDto {
  fleetId: string;
  stock: ChildSeatCounts;
}

export interface SetChildSeatStockDto {
  /** Société ciblée (super-admin) ; sinon celle du compte. */
  fleetId?: string;
  baby: number;
  child: number;
}

/** Ce qui reste disponible sur un créneau : stock − sièges engagés par les réservations qui le chevauchent. */
export interface ChildSeatAvailabilityDto {
  startAt: string;
  endAt: string;
  stock: ChildSeatCounts;
  engaged: ChildSeatCounts;
  available: ChildSeatCounts;
}

/** Critères de réservation (matching véhicule + sièges auto pris sur le stock). */
export interface ReservationCriteria {
  minSeats?: number;
  /** Sièges auto « bébé » à installer (pris sur le stock de la société, sur le créneau). */
  childSeatsBaby?: number;
  /** Sièges auto « enfant » à installer (idem — jamais substituable au type bébé). */
  childSeatsChild?: number;
  /** Équipements requis : TOUS doivent être présents sur le véhicule (insensible à la casse). */
  requiredFeatures?: string[];
}

/** Demande de réservation : créneau + critères (+ véhicule si déjà choisi). */
export interface RequestReservationDto {
  /** Véhicule visé. Absent = demande « ouverte » sur critères (à affecter à la validation). */
  vehicleId?: string;
  /** Société ciblée pour une demande OUVERTE (sans véhicule) — requis côté super-admin pour
   *  ne pas auto-affecter un véhicule d'une autre société. Ignoré si `vehicleId` est fourni. */
  fleetId?: string;
  startAt: string; // ISO
  endAt: string; // ISO
  title?: string;
  reason?: string;
  criteria?: ReservationCriteria;
  /** Consigner une réservation DÉJÀ EFFECTUÉE mais non enregistrée (créneau passé). Réservé aux
   *  gestionnaires : entre CONFIRMÉE à sa date réelle, sans bloquer sur le trajet réel (attendu). */
  retroactive?: boolean;
}

/** Véhicule proposé par l'auto-complétion : libre sur le créneau ET conforme aux critères. */
export interface SuggestedVehicleDto {
  vehicleId: string;
  vehiclePlate: string | null;
  seats: number | null;
  features: string[];
  /** 0..1 — utilisation récente (tri : sous-utilisés d'abord = mutualisation). */
  utilizationRatio: number;
  underutilized: boolean;
}

export interface SuggestReservationResultDto {
  startAt: string;
  endAt: string;
  vehicles: SuggestedVehicleDto[];
  /**
   * Sièges auto sur ce créneau (stock de la société − engagés), quand la société est connue.
   * Un véhicule libre ne suffit pas : si le stock ne couvre pas le besoin, la réservation est
   * refusée — et l'IA de placement le sait (elle le lit dans son payload).
   */
  childSeats?: ChildSeatAvailabilityDto | null;
  /** Véhicules écartés faute de capacité renseignée (places NULL avec critère de places).
   *  Rendus visibles pour ne pas fausser silencieusement les résultats. */
  excludedUnknownCapacity: number;
  /** Véhicules conformes mais immobilisés (incident/maintenance bloquant sur le créneau). */
  excludedImmobilized: number;
  /** Véhicules conformes mais DORMANTS : boîtier muet depuis plus de 7 jours (seuil « arrêter de
   *  compter »). Écartés du vivier — on ne propose pas un véhicule qu'on ne sait plus localiser —
   *  mais toujours consultables sur leur fiche, et de retour dans le vivier dès la trame suivante.
   *  Exposé pour ne pas faire baisser un chiffre client EN SILENCE. Donnée INTERNE : jamais
   *  renvoyée au demandeur du lien public de réservation. */
  excludedDormant: number;
}

/** Validation d'une demande : fixe le véhicule (si « ouverte ») et passe CONFIRMED. */
export interface ConfirmReservationDto {
  vehicleId?: string;
}

/** Mise à jour d'une réservation (créneau / critères / libellé / véhicule). */
export interface UpdateReservationDto {
  startAt?: string;
  endAt?: string;
  title?: string;
  reason?: string;
  criteria?: ReservationCriteria;
  /** Réaffecter la réservation à un autre véhicule (re-vérifie les conflits sur la cible). */
  vehicleId?: string;
  /** Marque/maintient la réservation comme « déjà effectuée » (autorise un créneau passé à l'édition). */
  retroactive?: boolean;
}
