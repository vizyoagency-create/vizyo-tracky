/**
 * Demande CDEF (2026-07) — Page flotte de gestion des horaires (coupe/reprise moteur auto).
 *
 * Une SEULE page pour superviser + éditer les horaires programmés de toute la flotte, avec
 * état live et compte-à-rebours. La config d'un planning reste écrite via l'endpoint
 * per-véhicule existant (`PUT /vehicles/:id/schedule`) → la fiche véhicule et cette page
 * partagent la même source de vérité (aucun doublon).
 *
 * Ces DTO décrivent le MODÈLE DE LECTURE (liste + état dérivé) et le bulk (activer tout +
 * poser des horaires d'un coup). Ils ne remplacent pas `UpsertVehicleScheduleDto`.
 */

/** État courant de la fenêtre horaire (résultat de l'évaluateur). */
export type FleetScheduleWindowState = 'IN_WINDOW' | 'OUT_OF_WINDOW';

/** État coupe moteur dérivé (aligné sur VehicleSnapshotDto.engineCutState). */
export type FleetScheduleEngineCutState = 'normal' | 'pending' | 'cut';

/**
 * Pourquoi la coupe automatique n'est pas (encore) appliquée alors que le véhicule est
 * hors plage. Sert à afficher l'état en évidence sur la page (demande CDEF « tout catcher »).
 *   - DRIVING       : le véhicule ROULE ENCORE après l'heure de coupe (⚠️ à surveiller).
 *   - AWAITING_STOP : arrêté mais pas encore depuis 10 min (attente de la règle d'immobilité).
 *   - OFFLINE       : hors ligne → la commande de coupe ne peut pas être livrée pour l'instant.
 */
export type FleetSchedulePendingReason = 'DRIVING' | 'AWAITING_STOP' | 'OFFLINE';

/** Une ligne de la vue flotte : 1 véhicule + son planning + son état live dérivé. */
export interface FleetScheduleRowDto {
  vehicleId: string;
  fleetId: string;
  plate: string;
  brand: string | null;
  model: string | null;
  group: { id: string; name: string } | null;

  trackerId: string | null;
  hasTracker: boolean;

  // --- Config planning (null/false si aucun planning créé) ---
  scheduleExists: boolean;
  scheduleEnabled: boolean;
  timezone: string | null;
  /** Description humaine de la fenêtre du jour (ex. « 08:00-22:00 »). Null si pas de planning. */
  windowDesc: string | null;
  /** État courant de la fenêtre (null si planning inexistant/désactivé). */
  windowState: FleetScheduleWindowState | null;
  /** `true` tant qu'un override manuel/veilleur suspend le planning (overrideUntil > now). */
  overrideActive: boolean;
  /** ISO — jusqu'à quand le planning est suspendu par un override, ou null. */
  overrideUntil: string | null;

  // --- Télémétrie live (dénormalisée Tracker.last*) ---
  lastSpeedKmh: number | null;
  lastIgnition: boolean | null;
  /** ignition ON ET vitesse > 5 km/h (même seuil que l'évaluateur de coupe). */
  moving: boolean;
  lastPositionAt: string | null;
  lastSeenAt: string | null;
  /** État coupe moteur dérivé (null si pas de tracker). */
  engineCutState: FleetScheduleEngineCutState | null;

  // --- Dérivés planning + live ---
  /** ISO — prochaine bascule (coupe ou reprise), ou null si aucune dans l'horizon. */
  nextTransitionAt: string | null;
  nextTransitionAction: 'CUT' | 'RESTORE' | null;
  /** `true` si le planning veut couper (hors plage) mais que le moteur n'est PAS encore coupé. */
  cutPending: boolean;
  /** Détail du report quand `cutPending` (roule / attend l'arrêt / hors ligne), sinon null. */
  pendingReason: FleetSchedulePendingReason | null;
  /** ISO — quand la coupe pourra s'appliquer (arrêt + 10 min), si AWAITING_STOP. Sinon null. */
  awaitingStopUntil: string | null;
}

export interface FleetScheduleListResponse {
  items: FleetScheduleRowDto[];
  /** Fenêtre d'immobilité minimale avant coupe auto (secondes) — pour l'affichage. */
  scheduleCutMinStoppedSec: number;
  /** ISO — horloge serveur, pour aligner les compte-à-rebours côté client. */
  serverNow: string;
  /**
   * `true` si le calcul a été borné (trop de véhicules « en attente d'arrêt » à scanner) :
   * certaines lignes AWAITING_STOP n'ont pas leur `awaitingStopUntil` précis. Jamais un
   * cap silencieux — la page peut le signaler.
   */
  awaitingStopScanTruncated: boolean;
}

/**
 * Corps du bulk « activer tout + poser des horaires ». La forme des horaires réutilise
 * exactement `UpsertVehicleScheduleDto` (mêmes champs/validation), appliquée à chaque
 * véhicule ciblé via le MÊME chemin d'écriture que la fiche véhicule.
 */
export interface BulkScheduleApplyRequest {
  /**
   * Flotte ciblée. OBLIGATOIRE pour un SUPER_ADMIN (sinon 400) : empêche d'appliquer par
   * mégarde à TOUTES les flottes. Pour un non-super, ignoré (déjà scopé à sa flotte).
   */
  fleetId?: string | null;
  /**
   * Véhicules ciblés. Omis/`null` = TOUS les véhicules de la flotte ciblée (ou du périmètre
   * de l'appelant) sur lesquels il a la permission `schedules_manage`.
   */
  vehicleIds?: string[] | null;
  /** La config d'horaires à appliquer (shape UpsertVehicleScheduleDto). */
  schedule: Record<string, unknown>;
}

export interface BulkScheduleApplyItemResult {
  vehicleId: string;
  plate: string | null;
  ok: boolean;
  /** Résumé de l'effet immédiat : 'cut' (coupé maintenant), 'deferred' (report), 'none' (dans la plage / rien). */
  immediate?: 'cut' | 'deferred' | 'none';
  error?: string;
}

export interface BulkScheduleApplyResponse {
  total: number;
  applied: number;
  failed: number;
  results: BulkScheduleApplyItemResult[];
}

/**
 * Aperçu AVANT d'appliquer un bulk : combien de véhicules seraient coupés MAINTENANT, etc.
 * Permet à l'opérateur de « tout voir » avant de valider (aucune écriture).
 */
export interface BulkSchedulePreviewResponse {
  total: number;
  /** Dans la plage à l'instant T → aucune coupe. */
  inWindowNow: number;
  /** Hors plage → coupe voulue. Réparti selon l'effet immédiat attendu. */
  outOfWindowNow: number;
  /** Hors plage + à l'arrêt depuis ≥ 10 min → seraient coupés immédiatement. */
  wouldCutNow: number;
  /** Hors plage, à l'arrêt mais depuis MOINS de 10 min → coupe différée (règle d'immobilité). */
  wouldDeferDwell: number;
  /** Hors plage mais roule → coupe différée (jamais en mouvement). */
  wouldDeferMoving: number;
  /** Hors plage mais hors ligne → coupe en attente de reconnexion. */
  wouldDeferOffline: number;
  /** Sans tracker → planning inapplicable. */
  withoutTracker: number;
}
