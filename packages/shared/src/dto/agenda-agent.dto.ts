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

/**
 * Statut d'une proposition de l'agent.
 *
 * `expired` (design/C3 point 7, 2026-09-05) : une suggestion `pending` dont le créneau est passé.
 * Relevé en production le 05/09 : 1 954 `pending` dont 1 615 périmées, jamais aucune expiration —
 * la liste montrait les 200 plus anciennes, toutes dépassées. Le cron horaire de l'agenda les
 * bascule ; elles ne sont plus listées, et une réservation ferme n'est jamais concernée.
 */
export type AgendaAgentProposalStatus = 'pending' | 'auto_applied' | 'applied' | 'dismissed' | 'expired';

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
  /**
   * Verdict de l'IA, rendu APRÈS coup par la file du poste (design/C3 point 7) : la proposition
   * naît avec une phrase mécanique, l'avis arrive au passage suivant du courrier (06:30 / 14:30).
   * `aiVerdictAt` nul = avis pas encore rendu. `aiKeep` false a passé la proposition en
   * `dismissed` avec la raison de l'IA dans `reasoning` ; true = conservée, `reasoning` vulgarisé.
   */
  aiVerdictAt: string | null; // ISO
  aiKeep: boolean | null;
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
  /**
   * Un travail `jugement-agenda` a été confié à la file du poste pour ce passage (design/C3
   * point 7) : l'avis de l'IA arrivera au prochain passage du courrier. false = IA coupée pour
   * la société, aucun motif à juger, ou file indisponible — les propositions restent telles
   * quelles, avec leur phrase mécanique. L'écran ne promet un avis que si c'est vrai.
   */
  aiVerdictQueued?: boolean;
}

/**
 * Un PASSAGE de l'agent, tel qu'archivé. Répond à « qu'a fait l'agent cette nuit, et pourquoi
 * si peu ? » — jusqu'ici seul `lastRunAt` survivait, donc la question restait sans réponse.
 * Les passages sautés (agent désactivé, ou déjà en cours) ne produisent PAS de ligne : ils
 * n'ont rien exécuté.
 */
export interface AgendaAgentRunDto {
  id: string;
  startedAt: string; // ISO
  finishedAt: string | null;
  /** 'scheduled' | 'manual' */
  origin: string;
  /** 'completed' | 'error' */
  status: string;
  /** Récurrences détectées : 0 motif explique un passage à 0 proposition. */
  patterns: number;
  created: number;
  proposed: number;
  skipped: number;
  /**
   * La couche IA a-t-elle réellement jugé ce passage ? Toujours false à la création depuis le
   * 2026-09-05 (design/C3 point 7) : le jugement est confié à la file du poste, et le passage
   * ne devient `aiUsed` que lorsque le cron horaire CONSOMME le verdict. false durablement =
   * agent déterministe seul (IA coupée pour la société) ou verdict jamais rendu.
   */
  aiUsed: boolean;
  durationMs: number;
  /** Message d'erreur si le passage a échoué (tronqué). */
  error: string | null;
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
