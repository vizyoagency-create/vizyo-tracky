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

/* ── Palier 3 — Récit LLM + mode « Comparer » (A/B les 2 IA) ── */

/** Résultat d'un moteur IA sur un trajet (récit + Trust Score + conseils + coût). */
export interface TripAiResultDto {
  provider: 'claude' | 'gpt';
  model: string | null;
  narrative: string | null;
  advice: string | null;
  trustScore: number | null;
  /** Coût de CET appel (€). */
  costEur: number;
  latencyMs: number | null;
  /** Renseigné si ce moteur a échoué (ex. GPT sans quota) — l'autre reste exploitable. */
  error: string | null;
}

/** Comparaison A/B : le MÊME trajet analysé par Claude ET GPT, côte à côte. */
export interface TripNarrativeCompareDto {
  tripId: string;
  results: TripAiResultDto[];
}

/* ── Notation — score de conduite agrégé par véhicule / conducteur / groupe ── */

/** Sur quoi agréger la note de conduite. */
export type DrivingScoreScope = 'vehicle' | 'driver' | 'group';

/** Une ligne notée : une entité (véhicule/conducteur/groupe) + son score de conduite moyen. */
export interface DrivingScoreRowDto {
  /** vehicleId | driverId | groupId. */
  id: string;
  /** Plaque | Nom du conducteur | Nom du groupe. */
  label: string;
  /** Sous-titre (modèle du véhicule, groupe du conducteur…). */
  sublabel: string | null;
  /** Couleur (conducteur), sinon null. */
  color: string | null;
  /** Score de conduite moyen 0-100 (moyenne des éco-scores des trajets). */
  score: number;
  /** Note lettrée A (excellent) → E (à améliorer). */
  grade: string;
  tripCount: number;
  distanceKm: number;
  /** Nombre total de trajets AVEC au moins un excès. */
  speedingTrips: number;
  /** Nombre total d'à-coups (accél/freinages brusques). */
  harshCount: number;
  fuelLiters: number;
  co2Kg: number;
}

/** Classement noté (meilleur → moins bon) + moyenne globale, sur une période. */
export interface DrivingScoresDto {
  scope: DrivingScoreScope;
  from: string;
  to: string;
  rows: DrivingScoreRowDto[];
  /** Moyenne globale de tous les trajets de la période (0-100), ou null si aucun. */
  overallScore: number | null;
  overallGrade: string | null;
  totalTrips: number;
}
