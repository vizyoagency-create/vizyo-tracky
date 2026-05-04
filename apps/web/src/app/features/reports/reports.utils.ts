/**
 * Helpers purs et testables pour le module Rapports.
 *
 * Toutes ces fonctions sont :
 *   - sans dependance Angular (testable sans TestBed),
 *   - defensives par construction (clamp les valeurs aberrantes),
 *   - alignees sur le contrat backend (`apps/api/src/trips/trips.service.ts`)
 *     et le plafond de vitesse `TRIP_MAX_PLAUSIBLE_SPEED_KMH = 250 km/h`
 *     (cf. `packages/shared/src/utils/gps-sanity.ts`).
 *
 * Verrouilles par `reports.utils.spec.ts` — toute regression ramene des
 * "-11min" / "9999 km/h" dans le tableau rapports.
 */

/** Plafond defensif vitesse km/h (aligne sur backend). */
export const REPORT_MAX_PLAUSIBLE_SPEED_KMH = 250;

/** Clamp d'un nombre quelconque en >= 0 (tolere `null`, `undefined`, NaN). */
export function max0(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  return n > 0 ? n : 0;
}

/** Clamp d'une vitesse en km/h dans [0, 250]. */
export function clampSpeed(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > REPORT_MAX_PLAUSIBLE_SPEED_KMH) return REPORT_MAX_PLAUSIBLE_SPEED_KMH;
  return n;
}

/**
 * Formate une duree en secondes vers "Xh00" / "Xmin".
 * Defensif : negatives, NaN, Infinity, null → "0min".
 */
export function formatDuration(seconds: number | null | undefined): string {
  const s = (seconds != null && Number.isFinite(seconds) && seconds > 0)
    ? seconds
    : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m}min`;
}

/**
 * Sous-ensemble du `TripDto` necessaire au calcul des KPI rapports.
 * On reste laxe sur les types pour pouvoir nourrir les tests avec des
 * objets minimaux sans devoir construire un `TripDto` complet.
 */
export interface TripKpiShape {
  durationSeconds: number;
  distanceMeters: number;
  maxSpeed: number;
}

export interface ReportsKpis {
  tripCount: number;
  totalDistance: number; // metres, >= 0
  totalDuration: number; // secondes, >= 0
  maxSpeed: number;      // km/h, [0, 250]
}

/**
 * Agregation defensive des KPI a partir d'une liste de trips.
 * Toutes les valeurs negatives ou aberrantes sont clampees AVANT l'agregation,
 * donc les totaux sont garantis >= 0 et coherents avec ce que la page
 * affiche cellule par cellule.
 */
export function aggregateKpis(trips: ReadonlyArray<TripKpiShape>): ReportsKpis {
  let totalDistance = 0;
  let totalDuration = 0;
  let maxSpeed = 0;
  for (const t of trips) {
    totalDistance += max0(t.distanceMeters);
    totalDuration += max0(t.durationSeconds);
    const spd = clampSpeed(t.maxSpeed);
    if (spd > maxSpeed) maxSpeed = spd;
  }
  return {
    tripCount: trips.length,
    totalDistance,
    totalDuration,
    maxSpeed,
  };
}
