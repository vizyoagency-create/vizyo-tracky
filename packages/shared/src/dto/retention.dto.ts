/**
 * Sprint 6 — Rétention & archivage des positions GPS — types partagés API ↔ web.
 *
 * Pipeline : positions ACTIVES (< retentionDays) → fenêtre d'ARCHIVE/PRÉAVIS
 * [retentionDays, retentionDays + archiveDays] (encore en base, RÉCUPÉRABLES, marquées
 * « suppression le … ») → SUPPRESSION au-delà. Ancrage sur `createdAt` (heure serveur,
 * fiable). La suppression réelle n'a lieu QUE si POSITIONS_PURGE_ENABLED='true' ; sinon
 * DRY-RUN (on compte, on alimente les vues, on n'efface RIEN).
 *
 * Ces DTO ne portent que des AGRÉGATS (compteurs + dates), jamais de positions brutes.
 */

/** Configuration de la rétention (lue côté serveur depuis l'env). */
export interface RetentionConfigDto {
  /** Fenêtre active (jours) avant passage en archive/préavis. */
  retentionDays: number;
  /** Durée du préavis / archive récupérable (jours) avant suppression. */
  archiveDays: number;
  /** false = DRY-RUN (aucune suppression réelle) ; true = suppression activée. */
  purgeEnabled: boolean;
}

/** État de rétention d'un périmètre (global ou une flotte). */
export interface RetentionSnapshotDto {
  /** 'GLOBAL' ou un fleetId. */
  scope: string;
  /** Nom lisible (« Global » ou le nom de la flotte). */
  fleetName: string;
  /** Positions actives (< retentionDays). */
  activeCount: number;
  /** Positions en archive/préavis ([retentionDays, retentionDays+archiveDays]) — récupérables. */
  archiveCount: number;
  /** Positions au-delà du préavis (≥ retentionDays+archiveDays) — éligibles à la suppression. */
  toDeleteCount: number;
  /** Position la plus ancienne (createdAt, ISO), ou null si aucune. */
  oldestCreatedAt: string | null;
  /** Date (ISO) à laquelle la position la plus ancienne sera supprimée (oldest + retention+archive). */
  nextDeletionAt: string | null;
}

/** Vue super-admin : config + global + par flotte. */
export interface RetentionOverviewDto {
  config: RetentionConfigDto;
  global: RetentionSnapshotDto;
  fleets: RetentionSnapshotDto[];
  /** Dernier calcul du snapshot (cron nocturne ou rafraîchissement manuel), ISO. */
  computedAt: string | null;
}

/** Vue fleet-admin : config + le snapshot de SA flotte. */
export interface RetentionFleetViewDto {
  config: RetentionConfigDto;
  snapshot: RetentionSnapshotDto;
  computedAt: string | null;
}
