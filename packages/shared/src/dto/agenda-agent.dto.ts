/**
 * Refonte agenda/IA (2026-07) — Réglages de l'agent d'optimisation d'agenda, PAR FLOTTE.
 * Pilotés depuis la ⚙️ « Paramètres de l'agenda ». Consommés par l'agent nocturne (P3).
 * Types partagés API ↔ web.
 */

import type { FleetMetier } from './ai-optimization.dto';

/** Cadence de l'analyse nocturne. */
export type AgendaAgentFrequency = 'daily' | 'weekly';

/**
 * Niveau d'autonomie :
 * - `suggest` : l'IA PROPOSE, rien n'entre dans l'agenda sans validation humaine.
 * - `auto_high_confidence` : l'IA réserve FERMEMENT les récurrences au-dessus du seuil de
 *   confiance ; tout le reste retombe en suggestions.
 */
export type AgendaAgentAutonomy = 'suggest' | 'auto_high_confidence';

export const AGENDA_AGENT_AUTONOMY_LABELS: Record<AgendaAgentAutonomy, string> = {
  suggest: 'Suggestions seules',
  auto_high_confidence: 'Auto si confiance haute',
};

/** Réglages courants de l'agent pour une flotte (lecture). */
export interface AgendaAgentSettingsDto {
  fleetId: string;
  fleetName: string | null;
  enabled: boolean;
  /** Heure de l'analyse nocturne (0-23, Europe/Paris). */
  nightlyHour: number;
  frequency: AgendaAgentFrequency;
  autonomy: AgendaAgentAutonomy;
  /** Seuil de confiance % (0-100) au-dessus duquel l'auto réserve fermement. */
  confidenceThreshold: number;
  autoCompleteAfterReservation: boolean;
  triggerNightly: boolean;
  triggerIncident: boolean;
  triggerMaintenance: boolean;
  triggerReservation: boolean;
  /** Métier de la flotte (lecture — édité via l'endpoint dédié `/ai/fleet-metier`). */
  metier: FleetMetier;
  /** Dernière exécution de l'agent (ISO) ou null. */
  lastRunAt: string | null;
  /** Coût IA de CETTE flotte depuis le 1er du mois (€, indicatif). */
  monthCostEur: number;
}

/** Statut d'une proposition de l'agent. */
export type AgendaAgentProposalStatus = 'pending' | 'auto_applied' | 'applied' | 'dismissed';

/** Une proposition de l'agent nocturne : occurrence récurrente projetée (suggestion ou auto). */
export interface AgendaAgentProposalDto {
  id: string;
  fleetId: string;
  vehicleId: string;
  vehiclePlate: string | null;
  startAt: string; // ISO
  endAt: string; // ISO
  dayOfWeek: number; // 1-7
  destinationLabel: string | null;
  confidence: number; // 0..1
  basis: string;
  reasoning: string;
  status: AgendaAgentProposalStatus;
  origin: string; // scheduled | manual | incident | maintenance | reservation
  createdEventId: string | null;
  createdAt: string; // ISO
}

/** Bilan d'une exécution de l'agent. */
export interface AgendaAgentRunResultDto {
  /** Réservations FERMES créées automatiquement (autonomie auto + confiance ≥ seuil). */
  created: number;
  /** Suggestions ajoutées (à valider). */
  proposed: number;
  /** Occurrences ignorées (créneau occupé / déjà proposée / trop proche). */
  skipped: number;
  /** L'agent tournait déjà pour cette flotte (anti-chevauchement). */
  alreadyRunning?: boolean;
}

/** Mise à jour des réglages (partielle). `fleetId` requis pour un super-admin. */
export interface SetAgendaAgentSettingsDto {
  fleetId?: string;
  enabled?: boolean;
  nightlyHour?: number;
  frequency?: AgendaAgentFrequency;
  autonomy?: AgendaAgentAutonomy;
  confidenceThreshold?: number;
  autoCompleteAfterReservation?: boolean;
  triggerNightly?: boolean;
  triggerIncident?: boolean;
  triggerMaintenance?: boolean;
  triggerReservation?: boolean;
}
