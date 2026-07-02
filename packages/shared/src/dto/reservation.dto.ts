/**
 * Sprint 8 (Palier B) — Réservations de véhicules (créneau + critères) portées par le modèle
 * d'événement S7 (`VehicleEvent` type=RESERVATION). Flux Demande → validation :
 *   REQUESTED (déposée, non bloquant) → CONFIRMED (ferme, bloquant) → IN_PROGRESS → DONE ;
 *   CANCELLED couvre refus/annulation. La réservation est représentée par `VehicleEventDto`
 *   (metadata porte demandeur + critères + motif). Types partagés API ↔ web.
 */

/** Critères de réservation (matching véhicule). */
export interface ReservationCriteria {
  minSeats?: number;
  minChildSeats?: number;
  /** Équipements requis : TOUS doivent être présents sur le véhicule (insensible à la casse). */
  requiredFeatures?: string[];
}

/** Demande de réservation : créneau + critères (+ véhicule si déjà choisi). */
export interface RequestReservationDto {
  /** Véhicule visé. Absent = demande « ouverte » sur critères (à affecter à la validation). */
  vehicleId?: string;
  startAt: string; // ISO
  endAt: string; // ISO
  title?: string;
  reason?: string;
  criteria?: ReservationCriteria;
}

/** Véhicule proposé par l'auto-complétion : libre sur le créneau ET conforme aux critères. */
export interface SuggestedVehicleDto {
  vehicleId: string;
  vehiclePlate: string | null;
  seats: number | null;
  childSeats: number | null;
  features: string[];
  /** 0..1 — utilisation récente (tri : sous-utilisés d'abord = mutualisation). */
  utilizationRatio: number;
  underutilized: boolean;
}

export interface SuggestReservationResultDto {
  startAt: string;
  endAt: string;
  vehicles: SuggestedVehicleDto[];
  /** Véhicules écartés faute de capacité renseignée (places/sièges-enfant NULL avec critère).
   *  Rendus visibles pour ne pas fausser silencieusement les résultats. */
  excludedUnknownCapacity: number;
  /** Véhicules conformes mais immobilisés (incident/maintenance bloquant sur le créneau). */
  excludedImmobilized: number;
}

/** Validation d'une demande : fixe le véhicule (si « ouverte ») et passe CONFIRMED. */
export interface ConfirmReservationDto {
  vehicleId?: string;
}

/** Mise à jour d'une réservation (créneau / critères / libellé). */
export interface UpdateReservationDto {
  startAt?: string;
  endAt?: string;
  title?: string;
  reason?: string;
  criteria?: ReservationCriteria;
}
