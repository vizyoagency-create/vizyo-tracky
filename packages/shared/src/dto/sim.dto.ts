/**
 * V1.16 — DTOs Cartes SIM (parc M2M WhereverSIM), partages frontend/backend.
 *
 * Le `Sim` Tracky est un miroir du SIM cote WhereverSIM (source de verite de
 * l'inventaire, du statut operateur et de la conso data) + une couche Tracky
 * (allocation flotte + assignation tracker). Cf. SimsService / SimsSyncService.
 *
 * Conventions : volumes en octets (`number`), timestamps en ISO 8601.
 */

/** statusid bruts WhereverSIM (cf. docs.whereversim.com — "List of possible SIM status"). */
export const SIM_STATUS = {
  NO_STATUS: 1,
  ACTIVATED: 2,
  ISSUED: 3,
  DELETED: 4,
  DEACTIVATED: 5,
  TEST_READY: 6,
  RETIRED: 7,
  ACTIVATION_READY: 8,
  INVENTORY: 9,
  REPLACED: 10,
  ACTIVATION_PENDANT: 11,
  SUSPENDED: 12,
} as const;

/** Libelles FR par statusid (fallback "Statut N" au-dela). */
export const SIM_STATUS_LABELS: Record<number, string> = {
  1: 'Inconnu',
  2: 'Activée',
  3: 'Émise',
  4: 'Supprimée',
  5: 'Désactivée',
  6: 'Prête (test)',
  7: 'Résiliée',
  8: 'Prête à activer',
  9: 'En stock',
  10: 'Remplacée',
  11: 'Activation en attente',
  12: 'Suspendue',
};

export type SimStatusCategory = 'active' | 'suspended' | 'pending' | 'inactive' | 'unknown';

/** Categorie d'affichage (couleur de badge) derivee du statusid. */
export function simStatusCategory(statusId: number | null | undefined): SimStatusCategory {
  switch (statusId) {
    case SIM_STATUS.ACTIVATED:
    case SIM_STATUS.TEST_READY:
      return 'active';
    case SIM_STATUS.SUSPENDED:
      return 'suspended';
    case SIM_STATUS.ISSUED:
    case SIM_STATUS.ACTIVATION_READY:
    case SIM_STATUS.ACTIVATION_PENDANT:
    case SIM_STATUS.INVENTORY:
      return 'pending';
    case SIM_STATUS.DEACTIVATED:
    case SIM_STATUS.DELETED:
    case SIM_STATUS.RETIRED:
    case SIM_STATUS.REPLACED:
      return 'inactive';
    default:
      return 'unknown';
  }
}

export function simStatusLabel(statusId: number | null | undefined): string {
  if (statusId == null) return '—';
  return SIM_STATUS_LABELS[statusId] ?? `Statut ${statusId}`;
}

/** Flotte resumee portee par une SIM. */
export interface SimFleetRefDto {
  id: string;
  name: string;
}

/** Tracker resume porte par une SIM posee. */
export interface SimTrackerRefDto {
  id: string;
  imei: string;
  vehiclePlate: string | null;
  /** Groupe (unique) du véhicule porteur, pour relier SIM → véhicule → groupe. */
  vehicleGroup: { id: string; name: string } | null;
}

export interface SimDto {
  id: string;
  iccid: string;
  msisdn: string | null;
  imsi: string | null;
  imei: string | null;
  provider: string;
  providerId: number | null;
  statusId: number | null;
  statusLabel: string | null;
  apn: string | null;
  ipAddress: string | null;
  networkOperator: string | null;
  /** Octets consommes ce mois-ci. */
  monthlyDataVolumeBytes: number | null;
  /** Octets ; null ou 0 = illimite. */
  monthlyDataLimitBytes: number | null;
  prevMonthDataVolumeBytes: number | null;
  /** ISO 8601 ou null. */
  inSessionSince: string | null;
  activationAt: string | null;
  customField1: string | null;
  label: string | null;
  notes: string | null;
  /** Allocation societe (null = stock central). */
  fleet: SimFleetRefDto | null;
  /** Assignation tracker (null = non posee). */
  tracker: SimTrackerRefDto | null;
  externalSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** KPIs globaux (WhereverSIM getStatistics). */
export interface SimStatsDto {
  totalSimCards: number;
  activeSimCards: number;
  currentMonthlyDataUsage: number;
  previousMonthDataUsage: number;
}

/** Un point du rapport de conso journaliere (WhereverSIM getDataConsumptionReport). */
export interface SimConsumptionPointDto {
  /** "YYYY-MM-DD". */
  day: string;
  bytes: number;
}

/** Evenement SIM (WhereverSIM listSimEvents). */
export interface SimEventDto {
  /** ISO 8601. */
  timestamp: string;
  /** ex: consumption | lifecycle | presence | usageNotification | ... */
  type: string;
  details: unknown;
}

/** Tracker assignable a une SIM (picker). */
export interface AssignableTrackerDto {
  id: string;
  imei: string;
  vehiclePlate: string | null;
  fleetName: string | null;
}

// ---- Requetes ----

export interface CreateSimDto {
  iccid: string;
  msisdn?: string | null;
  label?: string | null;
  /** Allocation immediate a une flotte (SUPER_ADMIN). */
  fleetId?: string | null;
}

/** Import par lot : colle d'une liste (1 SIM par ligne, ICCID [+ MSISDN [+ label]]). */
export interface BulkCreateSimDto {
  raw: string;
}

export interface BulkCreateSimResultDto {
  created: SimDto[];
  skipped: { iccid: string; reason: string }[];
}

export interface UpdateSimDto {
  label?: string | null;
  notes?: string | null;
  /** Allocation / desallocation societe (SUPER_ADMIN). null = retour au stock. */
  fleetId?: string | null;
}

export interface AssignSimDto {
  trackerId: string;
}

export interface SetSimStatusDto {
  /** statusid cible (cf. SIM_STATUS). */
  statusId: number;
}

export interface SetSimDataLimitDto {
  /** Octets ; null ou 0 = illimite. */
  bytes: number | null;
}

export interface SendSimSmsDto {
  text: string;
}
