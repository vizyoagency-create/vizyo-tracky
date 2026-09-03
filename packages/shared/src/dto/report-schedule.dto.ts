/**
 * Rapport hebdomadaire (2026-09) — réglage PAR SOCIÉTÉ de l'envoi automatique du rapport PDF.
 *
 * Avant : un cron unique (lundi 08:00 UTC), un seul destinataire (`Fleet.weeklyReportEmail`
 * ou le premier admin), un contenu figé, et le PDF annoncé « en pièce jointe » sans jamais
 * l'être. Rien de réglable par le client, rien de visible dans son espace.
 *
 * Maintenant : chaque société règle, depuis sa page Rapports, le jour, l'heure (Paris), les
 * destinataires, le contenu (mêmes sections que l'export PDF) et le périmètre véhicules ;
 * elle voit quand part le prochain rapport et ce qui s'est passé pour les précédents.
 */

export type FleetReportSection = 'kpi' | 'alerts' | 'topVehicles' | 'trips';
export type FleetReportDispatchStatus = 'SENT' | 'FAILED' | 'SKIPPED';
export type FleetReportTrigger = 'cron' | 'manual';

/** Réglage (lecture). Une société sans réglage enregistré reçoit les valeurs par défaut. */
export interface FleetReportScheduleDto {
  fleetId: string;
  fleetName: string;
  enabled: boolean;
  /** Jour d'envoi, 1 = lundi … 7 = dimanche (Europe/Paris). */
  weekday: number;
  /** Heure d'envoi, 0-23 (Europe/Paris). */
  hour: number;
  /** Destinataires choisis. Vide = les administrateurs actifs de la société. */
  recipients: string[];
  /** Destinataires effectivement visés au prochain envoi (choisis, sinon les admins). */
  effectiveRecipients: string[];
  sections: FleetReportSection[];
  /** Périmètre véhicules. Vide = tous les véhicules de la société. */
  vehicleIds: string[];
  maxTrips: number;
  topN: number;
  lastRunAt: string | null;
  lastStatus: FleetReportDispatchStatus | null;
  lastError: string | null;
  /** Prochain envoi (ISO). */
  nextDueAt: string;
  /** Période couverte par le prochain envoi — jours civils de Paris, fin INCLUSE. */
  nextPeriodFrom: string;
  nextPeriodTo: string;
  /** Vrai si aucun réglage n'a encore été enregistré (valeurs par défaut affichées). */
  isDefault: boolean;
  updatedAt: string | null;
}

/** Réglage (écriture). */
export interface SetFleetReportScheduleDto {
  enabled: boolean;
  weekday: number;
  hour: number;
  recipients: string[];
  sections: FleetReportSection[];
  vehicleIds: string[];
  maxTrips: number;
  topN: number;
}

/** Un envoi (journal) — ce que la société et l'admin voient de chaque passage. */
export interface FleetReportDispatchDto {
  id: string;
  fleetId: string;
  fleetName: string;
  createdAt: string;
  trigger: FleetReportTrigger;
  status: FleetReportDispatchStatus;
  /** Période couverte — jours civils de Paris, fin INCLUSE. */
  periodFrom: string;
  periodTo: string;
  recipients: string[];
  tripsCount: number;
  pdfBytes: number;
  error: string | null;
  requestedByName: string | null;
}

/** Résultat d'un envoi immédiat. */
export interface SendFleetReportNowResultDto {
  dispatch: FleetReportDispatchDto;
}
