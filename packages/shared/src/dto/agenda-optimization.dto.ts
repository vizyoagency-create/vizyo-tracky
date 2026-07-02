/**
 * Agenda AI — Vue « Optimisation & prévisions » (horizon ≈ 2 mois) + agent IA connecté.
 * Types partagés API ↔ web.
 *
 * Deux niveaux :
 *  1. OPPORTUNITÉS déterministes (calculées sans IA : sous-utilisation, coût/énergie,
 *     maintenances dues, jours en tension) — fiables, instantanées, gratuites.
 *  2. PROPOSITIONS de l'agent IA (réassignations, planifications, mutualisations) : l'IA
 *     PROPOSE avec un « pourquoi » vulgarisé ; selon l'autonomie, l'app valide ou applique.
 */

export type AgendaOptimizationAutonomy = 'PROPOSE' | 'AUTO';
export type AgendaOptimizationFrequency = 'daily' | 'weekly';
export type AgendaOptimizationOrigin = 'manual' | 'scheduled' | 'incident' | 'maintenance';
export type AgendaReportStatus = 'PENDING' | 'READY' | 'FAILED';

/* ─── Opportunités déterministes ─────────────────────────────────────────── */

export type OpportunityKind = 'mutualize' | 'cost_energy' | 'maintenance_due' | 'tension';

export interface OptimizationOpportunityDto {
  kind: OpportunityKind;
  /** Titre court et actionnable. */
  title: string;
  /** Explication vulgarisée (public non technique). */
  detail: string;
  severity: 'info' | 'warning' | 'critical';
  /** Économie estimée €/mois si l'opportunité est saisie (mutualisation/énergie). */
  savingsEurPerMonth?: number | null;
  vehicleIds: string[];
  vehiclePlates: string[];
  /** Date concernée (ISO) si applicable (jour en tension, échéance de maintenance). */
  atDate?: string | null;
}

/* ─── Propositions de l'agent IA ─────────────────────────────────────────── */

export type AiProposalKind = 'reassign' | 'schedule_maintenance' | 'mutualize' | 'note';
export type AiProposalStatus = 'pending' | 'applied' | 'dismissed';

export interface AiAgendaProposalDto {
  /** Identifiant local (pour appliquer/rejeter). */
  id: string;
  kind: AiProposalKind;
  title: string;
  /** LE POURQUOI, formulé simplement pour un utilisateur NON technique. */
  why: string;
  detail?: string | null;
  /** Réservation concernée (réassignation). */
  reservationId?: string | null;
  /** Véhicule cible (réassignation) ou concerné. */
  vehicleId?: string | null;
  vehiclePlate?: string | null;
  /** Créneau proposé (planification de maintenance). */
  startAt?: string | null;
  endAt?: string | null;
  savingsEurPerMonth?: number | null;
  /** 0..1 — certitude de l'IA. */
  confidence: number;
  status: AiProposalStatus;
}

export interface AgendaOptimizationReportDto {
  id: string;
  createdAt: string;
  fleetId: string;
  from: string;
  to: string;
  status: AgendaReportStatus;
  origin: AgendaOptimizationOrigin;
  /** Résumé vulgarisé (2-4 phrases). */
  summary: string | null;
  proposals: AiAgendaProposalDto[];
  error: string | null;
  /** Coût € de la génération (transparence). */
  costEur: number;
}

/* ─── Timeline prévisionnelle (2 mois) ───────────────────────────────────── */

export interface ForecastWeekBucketDto {
  /** Lundi de la semaine (ISO). */
  weekStart: string;
  /** Numéro de semaine ISO (label court « S29 »). */
  isoWeek: number;
  /** Nb de véhicules DISTINCTS dont l'usage est prévu dans la semaine (intensité de charge). */
  predictedVehicles: number;
  reservations: number;
  maintenances: number;
  incidents: number;
  /** Demande prévue (prévision + réservations) > véhicules disponibles → semaine tendue. */
  tension: boolean;
}

/* ─── Dashboard d'optimisation ───────────────────────────────────────────── */

export interface AgendaOptimizationDashboardDto {
  from: string;
  to: string;
  fleetId: string | null;
  /** Timeline hebdomadaire sur l'horizon (≈ 8-9 semaines). */
  weeks: ForecastWeekBucketDto[];
  /** KPIs de tête. */
  underutilizedCount: number;
  potentialSavingsEurPerMonth: number;
  maintenanceDueCount: number;
  tensionDaysCount: number;
  /** Opportunités déterministes (triées par sévérité puis économie). */
  opportunities: OptimizationOpportunityDto[];
  /** Dernier rapport IA (propositions), si présent. */
  latestReport: AgendaOptimizationReportDto | null;
  /** Config/planification de l'agent pour cette flotte. */
  schedule: AgendaOptimizationScheduleDto;
}

/* ─── Config / planification de l'agent ──────────────────────────────────── */

export interface AgendaOptimizationScheduleDto {
  fleetId: string | null;
  enabled: boolean;
  frequency: AgendaOptimizationFrequency;
  autonomy: AgendaOptimizationAutonomy;
  lastRunAt: string | null;
  updatedAt: string | null;
}

export interface SetAgendaOptimizationScheduleDto {
  /** Requis pour un super-admin (flotte ciblée). */
  fleetId?: string;
  enabled: boolean;
  frequency: AgendaOptimizationFrequency;
  autonomy: AgendaOptimizationAutonomy;
}

/** Lancement d'un scan IA à la demande. */
export interface RunAgendaOptimizationDto {
  fleetId?: string;
}

/** Appliquer / rejeter une proposition de l'agent. */
export interface ApplyAgendaProposalDto {
  reportId: string;
  proposalId: string;
}
