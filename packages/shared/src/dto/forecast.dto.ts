/**
 * Sprint 8 (Palier C) — Prévision d'usage récurrent. DÉRIVÉE de l'historique de trajets,
 * JAMAIS stockée comme événement, JAMAIS bloquante (ne compte pas dans les conflits ni la
 * disponibilité). Distincte d'une réservation ferme par nature même (un `ForecastSlotDto`
 * n'est pas un `VehicleEvent`). Types partagés API ↔ web.
 */

export interface ForecastSlotDto {
  vehicleId: string;
  vehiclePlate: string | null;
  /** ISO — créneau projeté (date de la fenêtre × heures typiques observées, TZ flotte). */
  startAt: string;
  endAt: string;
  /** ISO day-of-week : 1 = lundi … 7 = dimanche. */
  dayOfWeek: number;
  /** Base lisible de la prévision, ex. « 8/10 lundis ». */
  basis: string;
  /** 0..1 — proportion de semaines observées avec ce motif. */
  confidence: number;
}

export interface ForecastResultDto {
  from: string;
  to: string;
  /** Créneaux d'usage PRÉVU (informatifs), projetés sur la fenêtre. */
  slots: ForecastSlotDto[];
}
