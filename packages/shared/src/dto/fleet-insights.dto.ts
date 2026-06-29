/**
 * Sprint 8 (Palier A) — Visibilité flotte. Deux dérivations en LECTURE SEULE depuis les
 * trajets (`Trip`, conservés par la rétention S6) :
 *   1. Activité / disponibilité réelle (quand chaque véhicule a roulé) — couche agenda.
 *   2. Utilisation / optimisation (sous-utilisation, mutualisation) — dashboard.
 * Types partagés API ↔ web.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Activité réelle / disponibilité (un créneau par trajet)
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleActivitySlotDto {
  vehicleId: string;
  vehiclePlate: string | null;
  /** ISO — début du trajet (borné à la fenêtre demandée). */
  startAt: string;
  /** ISO — fin du trajet, ou null si trajet en cours. */
  endAt: string | null;
  /** true = trajet en cours (le véhicule roule actuellement). */
  ongoing: boolean;
  distanceKm: number;
}

export interface VehicleAvailabilityDto {
  from: string;
  to: string;
  /** Créneaux d'activité réelle (un par trajet chevauchant la fenêtre), périmètre de l'utilisateur. */
  slots: VehicleActivitySlotDto[];
  /** true si le nombre de trajets a atteint la borne défensive (résultat partiel). */
  truncated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Utilisation / optimisation (heatmap + sous-utilisation)
// ─────────────────────────────────────────────────────────────────────────────

/** Créneaux d'une journée : nuit [0-6) · matin [6-12) · après-midi [12-18) · soir [18-24). */
export type UtilizationSlot = 'night' | 'morning' | 'afternoon' | 'evening';

export interface UtilizationCellDto {
  /** ISO day-of-week : 1 = lundi … 7 = dimanche. */
  dayOfWeek: number;
  slot: UtilizationSlot;
  /** 0..1 — fraction des occurrences de ce créneau (sur la période) où le véhicule a roulé. */
  occupancy: number;
}

export interface VehicleUtilizationDto {
  vehicleId: string;
  vehiclePlate: string | null;
  tripCount: number;
  activeHours: number;
  distanceKm: number;
  /** Jours distincts (heure locale flotte) avec au moins un trajet. */
  activeDays: number;
  /** 0..1 — heures actives / heures de la fenêtre (indicatif). */
  utilizationRatio: number;
  /** true si l'utilisation est faible → candidat à la mutualisation. */
  underutilized: boolean;
  /** Heatmap : 28 cellules (7 jours × 4 créneaux). */
  cells: UtilizationCellDto[];
  /** Créneaux récurrents libres lisibles, ex. « Lundi matin », « Mardi après-midi ». */
  freePatterns: string[];
}

export interface FleetOptimizationDto {
  from: string;
  to: string;
  /** Nb de jours distincts de la fenêtre (heure locale flotte). */
  periodDays: number;
  /** Tous les véhicules du périmètre (y compris ceux sans aucun trajet = 0 % utilisé). */
  vehicles: VehicleUtilizationDto[];
}
