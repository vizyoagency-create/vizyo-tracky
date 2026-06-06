/**
 * V1.15 — DTOs Planning d'installation partages frontend/backend.
 *
 * Un `InstallationPlan` regroupe les vehicules d'une flotte a equiper, ordonnes
 * par `scheduledDate` (jour) + `orderIndex`. Chaque `InstallationTask` = un
 * vehicule. A la pose, on capture imei/simNumber puis on provisionne le Vehicle
 * + Tracker reels (vehicleId/trackerId renseignes).
 *
 * Conventions dates : champs "date seule" en "YYYY-MM-DD" (pas de fuseau) ;
 * `installedAt`/`createdAt`/`updatedAt` en ISO 8601 (instant).
 */

export type InstallationPlanStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

export type InstallationTaskStatus = 'PENDING' | 'DONE' | 'SKIPPED';

export type InstallationEnergy =
  | 'DIESEL'
  | 'ESSENCE'
  | 'ELECTRIQUE'
  | 'HYBRIDE'
  | 'AUTRE';

export interface InstallationTaskDto {
  id: string;
  planId: string;
  orderIndex: number;
  /** "YYYY-MM-DD" ou null (non planifie). */
  scheduledDate: string | null;
  plate: string;
  brand: string | null;
  model: string | null;
  energy: InstallationEnergy | null;
  /** "YYYY-MM-DD" (1ere mise en circulation). */
  firstRegistrationDate: string | null;
  cutoffProcedure: string | null;
  status: InstallationTaskStatus;
  /** ISO 8601 — instant de la pose. */
  installedAt: string | null;
  imei: string | null;
  simNumber: string | null;
  fieldNotes: string | null;
  /** Renseignes une fois le vehicule/tracker provisionnes dans la flotte. */
  vehicleId: string | null;
  trackerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstallationPlanSummaryDto {
  id: string;
  fleetId: string;
  clientName: string;
  clientAddress: string | null;
  description: string | null;
  /** "YYYY-MM-DD" ou null. */
  startDate: string | null;
  endDate: string | null;
  status: InstallationPlanStatus;
  /** Nombre de taches posees (status DONE). */
  doneCount: number;
  /** Nombre total de taches. */
  totalCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface InstallationPlanDto extends InstallationPlanSummaryDto {
  /** { "YYYY-MM-DD": "theme de la journee" }. */
  dayThemes: Record<string, string> | null;
  tasks: InstallationTaskDto[];
}

// ---- Requetes (operateur SUPER_ADMIN sauf reorder) ----

export interface CreateInstallationPlanDto {
  fleetId: string;
  clientName: string;
  clientAddress?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface UpdateInstallationPlanDto {
  clientName?: string;
  clientAddress?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: InstallationPlanStatus;
  dayThemes?: Record<string, string> | null;
}

export interface UpsertInstallationTaskDto {
  orderIndex?: number;
  scheduledDate?: string | null;
  plate?: string;
  brand?: string | null;
  model?: string | null;
  energy?: InstallationEnergy | null;
  firstRegistrationDate?: string | null;
  cutoffProcedure?: string | null;
  status?: InstallationTaskStatus;
  fieldNotes?: string | null;
}

export interface CompleteInstallationTaskDto {
  /** IMEI 15 chiffres — requis pour le provisioning auto. */
  imei: string;
  /** E.164 (ex +33612345678) ou vide. */
  simNumber?: string | null;
  fieldNotes?: string | null;
  /** ISO 8601 ; defaut = maintenant cote serveur. */
  installedAt?: string | null;
  /** Defaut DONE. */
  status?: InstallationTaskStatus;
}

export interface CompleteInstallationTaskResultDto {
  task: InstallationTaskDto;
  /** true si le Vehicle + Tracker ont ete crees/lies. */
  provisioned: boolean;
  /** Message si le provisioning a echoue (capture conservee malgre tout). */
  provisionError?: string | null;
}

export interface ReorderTaskItemDto {
  id: string;
  orderIndex: number;
  /** Optionnel — deplacer la tache vers un autre jour. "YYYY-MM-DD" ou null. */
  scheduledDate?: string | null;
}

export interface ReorderInstallationTasksDto {
  tasks: ReorderTaskItemDto[];
}
