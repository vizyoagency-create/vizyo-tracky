/**
 * Traçabilité fine des trajets (Palier 2) — analyse déterministe d'un trajet, réutilisée PARTOUT
 * (fiche véhicule → onglet Trajets, Rapports par véhicule, Replay). Calculée à partir des positions
 * GPS filtrées ; le récit + Trust Score LLM (Palier 3) s'ajoutent sans recalcul.
 */

export interface TripStopDto {
  lat: number;
  lng: number;
  arrivedAt: string;
  leftAt: string;
  durationMin: number;
}

/** Un segment d'excès de vitesse (vs limite OSM). */
export interface SpeedingSegmentDto {
  startAt: string;
  endAt: string;
  durationSec: number;
  maxSpeedKmh: number;
  limitKmh: number;
  overKmh: number;
  lat: number;
  lng: number;
}

export interface TripAnalysisDetailDto {
  /** Arrêts significatifs (≥ 4 min). */
  stops: TripStopDto[];
  /** Segments d'excès de vitesse (limite connue). */
  speeding: SpeedingSegmentDto[];
  /** Trous de signal GPS (secondes après le départ + durée du trou). */
  gpsGaps: { atSec: number; gapSec: number }[];
  /** Tracé simplifié (pour le replay / la carte) : lat/lng/temps/vitesse. */
  track: { lat: number; lng: number; t: string; speedKmh: number }[];
}

export interface TripAnalysisDto {
  tripId: string;
  vehicleId: string;
  computedAt: string;

  // Résumé
  distanceKm: number;
  durationSec: number;
  movingSec: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  stopCount: number;
  idleSec: number;

  // Qualité GPS
  gpsPoints: number;
  gpsValidRatio: number;
  gpsLostCount: number;

  // Excès de vitesse
  speedingCount: number;
  speedingSec: number;
  maxOverKmh: number;
  limitsKnown: boolean;

  // Éco-conduite
  harshAccel: number;
  harshBrake: number;
  ecoScore: number;
  fuelLiters: number | null;
  co2Kg: number | null;

  detail: TripAnalysisDetailDto;

  // Couche LLM (Palier 3) — null tant que non générée
  provider: string | null;
  narrative: string | null;
  advice: string | null;
  trustScore: number | null;
}
