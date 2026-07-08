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

/**
 * Passage détecté à une station-service (un ARRÊT du trajet tombe sur une station connue).
 * `unitPriceEur` = prix au litre capté au moment du passage pour le carburant du véhicule (peut être
 * null : carburant non déterminé, station sans ce carburant, ou API prix indisponible).
 */
export interface TripFuelStopDto {
  stationId: string;
  /** Marque (Total, Esso…) — best-effort via OSM, souvent null. */
  brand: string | null;
  name: string | null;
  city: string | null;
  address: string | null;
  lat: number;
  lng: number;
  arrivedAt: string;
  durationSec: number;
  /** Distance arrêt ↔ station (m). */
  distanceM: number;
  /** Carburant retenu ('gazole' | 'sp95' | 'sp98' | 'e10' | 'e85' | 'gplc') ou null. */
  fuelType: string | null;
  /** Prix au litre capté (€) ou null. */
  unitPriceEur: number | null;
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
  /** Passages en station-service détectés (arrêts tombant sur une station). Optionnel. */
  fuelStops?: TripFuelStopDto[];
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

/* ── Carburant — suivi des passages station & coûts par véhicule (P3) ── */

/** Une station distincte visitée par le véhicule + nombre de passages. */
export interface FuelStationVisitDto {
  stationId: string;
  brand: string | null;
  city: string | null;
  address: string | null;
  visits: number;
  /** Dernier prix capté à cette station pour le carburant du véhicule (€/L), ou null. */
  lastPriceEur: number | null;
}

/** Un point de prix daté (pour la tendance / sparkline). */
export interface FuelPricePointDto {
  at: string;
  priceEur: number;
}

/**
 * Suivi carburant d'un véhicule sur une période : fréquence des passages en station, prix constatés,
 * et coût carburant ESTIMÉ (litres estimés × prix). Deux coûts pour COMPARER : au prix réellement
 * constaté en station vs au prix paramétré de la flotte (`Fleet.fuelPriceEurL`, base du PDF).
 */
export interface VehicleFuelReportDto {
  vehicleId: string;
  from: string;
  to: string;
  /** Nombre de passages en station détectés sur la période. */
  visits: number;
  /** « Passe en station tous les X jours » (null si < 2 passages). */
  avgDaysBetween: number | null;
  /** Stations distinctes visitées (fréquence + dernier prix). */
  stations: FuelStationVisitDto[];
  /** Carburant retenu pour le véhicule ('gazole'…) ou null. */
  fuelType: string | null;
  // Prix constatés en station (pour le carburant du véhicule) sur la période.
  priceMin: number | null;
  priceMax: number | null;
  priceAvg: number | null;
  priceLatest: number | null;
  /** Tendance des prix constatés (dates + €/L), du plus ancien au plus récent. */
  priceTrend: FuelPricePointDto[];
  // Consommation & coût estimés (Σ des litres estimés des trajets analysés de la période).
  estimatedLiters: number;
  distanceKm: number;
  /** Coût au PRIX RÉEL CONSTATÉ (litres × prix moyen constaté), ou null si aucun prix capté. */
  costAtObservedEur: number | null;
  /** Coût au PRIX PARAMÉTRÉ de la flotte (litres × Fleet.fuelPriceEurL) — base du PDF actuel. */
  costAtFleetPriceEur: number | null;
  fleetPriceEurL: number | null;
}

/**
 * Station-service agrégée pour la CARTE (passages de toute la flotte). Sert à afficher un marqueur
 * par station, mis en avant selon la FRÉQUENCE (`visits`) et la RÉCENCE (`lastVisitAt`) d'usage.
 */
export interface FuelStationMapPointDto {
  stationId: string;
  brand: string | null;
  name: string | null;
  city: string | null;
  address: string | null;
  lat: number;
  lng: number;
  /** Nombre total de passages (toute la flotte) sur la période. */
  visits: number;
  /** Nombre de véhicules distincts passés par cette station. */
  distinctVehicles: number;
  /** Dernier passage (ISO) — pour la mise en avant « récemment utilisée ». */
  lastVisitAt: string;
  /** Dernier prix capté (€/L), tous carburants confondus, ou null. */
  lastPriceEur: number | null;
  fuelType: string | null;
}

/* ── Calibration carburant « méthode du plein » (P4) — coût auto + conso réelle ── */

/** Un plein renseigné (méthode du plein) + ses valeurs dérivées (distance/conso mesurée). */
export interface FuelFillUpDto {
  id: string;
  vehicleId: string;
  filledAt: string;
  litersFilled: number;
  amountPaidEur: number | null;
  fullTank: boolean;
  odometerKm: number | null;
  fuelType: string | null;
  stationId: string | null;
  /** Marque/ville de la station (si liée), pour l'affichage. */
  stationLabel: string | null;
  note: string | null;
  // Dérivés (calculés) :
  /** Distance depuis le plein complet précédent (km) — odomètre si dispo, sinon somme des trajets. */
  distanceSinceKm: number | null;
  /** Conso RÉELLE de ce réservoir (litres/distance × 100), si mesurable (2 pleins complets). */
  realConsumptionL100km: number | null;
  /** Prix au litre payé (montant/litres) ou prix constaté, ou null. */
  unitPriceEur: number | null;
}

/** Création / mise à jour d'un plein. */
export interface UpsertFuelFillUpDto {
  vehicleId: string;
  filledAt: string;
  litersFilled: number;
  amountPaidEur?: number | null;
  fullTank?: boolean;
  odometerKm?: number | null;
  fuelType?: string | null;
  stationId?: string | null;
  note?: string | null;
}

/** Niveau de confiance de la consommation calibrée. */
export type FuelConfidence = 'none' | 'low' | 'medium' | 'high';

/**
 * Modèle carburant CALIBRÉ d'un véhicule : consommation ESTIMÉE (paramètre/défaut) vs RÉELLE (méthode
 * du plein) + confiance, et coûts au PRIX RÉELLEMENT CONSTATÉ. Permet de montrer que l'app devient
 * précise « au fur et à mesure » : plus il y a de pleins renseignés, plus la conso/coût sont fiables.
 */
export interface VehicleFuelModelDto {
  vehicleId: string;
  from: string;
  to: string;
  // Consommation (L/100km)
  estimatedConsumptionL100km: number;
  calibratedConsumptionL100km: number | null;
  effectiveConsumptionL100km: number;
  consumptionSource: 'calibrated' | 'vehicle' | 'default';
  fuelType: string | null;
  // Confiance (basée sur le nb de réservoirs mesurés)
  fillUpCount: number;
  measuredTanks: number;
  confidence: FuelConfidence;
  // Distances / coûts sur la période
  distanceKm: number;
  effectiveLiters: number;
  observedPriceEurL: number | null;
  fleetPriceEurL: number | null;
  /** Coût estimé au PRIX CONSTATÉ avec la conso EFFECTIVE. */
  costAtObservedEur: number | null;
  /** Coût au prix PARAMÉTRÉ (comparaison). */
  costAtFleetPriceEur: number | null;
  // Réel (pleins renseignés)
  realLiters: number | null;
  realSpentEur: number | null;
  /** Écart conso estimée vs calibrée (%), si calibrée dispo. */
  deltaPercent: number | null;
  fillUps: FuelFillUpDto[];
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
  /** Nombre d'entités classées (véhicules/conducteurs/groupes). */
  rankedCount: number;
}

/**
 * Score PERSO d'UNE entité (véhicule/conducteur/groupe) : sa note + son RANG dans la compétition +
 * sa comparaison à la MOYENNE. Affiché dans chaque fiche détail pour motiver (« tu es 3e / 12 »).
 */
export interface DrivingScoreDetailDto {
  scope: DrivingScoreScope;
  id: string;
  from: string;
  to: string;
  /** Agrégat de l'entité (null = aucun trajet analysé sur la période). */
  row: DrivingScoreRowDto | null;
  /** Rang 1-based dans le classement (1 = meilleur), ou null si aucun trajet. */
  rank: number | null;
  /** Nombre total d'entités classées (le « / N »). */
  total: number;
  /** Moyenne de conduite de la flotte (0-100) sur la période. */
  overallScore: number | null;
  overallGrade: string | null;
  /** Écart à la moyenne (score de l'entité − moyenne). > 0 = au-dessus. */
  vsOverall: number | null;
}
