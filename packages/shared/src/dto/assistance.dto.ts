/**
 * Assistance IA (2026-08) — contrats partagés api/web.
 *
 * Deux surfaces distinctes, volontairement séparées :
 *   - CÔTÉ UTILISATEUR : sa conversation, ses messages. Rien d'autre. Aucun coût, aucun modèle,
 *     aucune trace de ce que l'agent est allé lire — ce sont des informations d'exploitation.
 *   - CÔTÉ ADMIN : la même conversation, plus ce qu'il faut pour la relire, la corriger et
 *     rappeler la personne : qui a demandé, ce que l'agent a consulté, ce que ça a coûté.
 *
 * Mélanger les deux dans un seul type ferait fuir le second vers le premier au premier oubli de
 * `select` — c'est le genre de fuite qui ne se voit pas en revue.
 */

export type AssistanceRole = 'user' | 'assistant' | 'admin';
export type AssistanceStatus = 'open' | 'closed' | 'escalated';
export type AssistanceGravite = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// ─── Côté utilisateur ────────────────────────────────────────────────────────

export interface AssistanceMessageDto {
  id: string;
  createdAt: string;
  role: AssistanceRole;
  content: string;
}

export interface AssistanceConversationDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  status: AssistanceStatus;
  escalatedAt: string | null;
  messages: AssistanceMessageDto[];
  /**
   * Nombre de réponses automatiques encore possibles dans CETTE conversation.
   *
   * Exposé à l'utilisateur, et pas seulement appliqué en silence : arriver à zéro sans
   * avertissement se lit comme une panne. L'écran peut prévenir avant, et proposer le rappel.
   */
  reponsesRestantes: number;
}

export interface AssistanceListItemDto {
  id: string;
  createdAt: string;
  title: string;
  status: AssistanceStatus;
  /** Dernier message, tronqué — de quoi reconnaître la conversation dans une liste. */
  apercu: string;
}

/** Poser une question (nouvelle conversation ou suite d'une conversation existante). */
export interface AskAssistanceDto {
  message: string;
}

/** Demander un rappel humain — court-circuite l'IA. */
export interface AssistanceRappelDto {
  /** Motif libre, facultatif : la personne est peut-être pressée. */
  motif?: string;
}

// ─── Côté admin ──────────────────────────────────────────────────────────────

export interface AssistanceAdminListItemDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  status: AssistanceStatus;
  severity: AssistanceGravite | null;
  userEmail: string | null;
  fleetName: string | null;
  messageCount: number;
  escalatedAt: string | null;
  /** Relue par un admin ? La relecture est le but même de l'archive. */
  reviewedAt: string | null;
  costEur: number;
}

/** Un message vu par un admin : ce qui a produit la réponse, en plus de la réponse. */
export interface AssistanceAdminMessageDto extends AssistanceMessageDto {
  model: string | null;
  costEur: number;
  latencyMs: number | null;
  /**
   * Ce que l'agent est allé LIRE pour produire ce message : la clé du lot, son volume, et s'il a
   * été refusé. Jamais les données elles-mêmes — les dupliquer hors de leur table créerait une
   * seconde copie à protéger, et à purger.
   */
  contextUsed: Array<{ key: string; volume: number; refuse: boolean }> | null;
}

export interface AssistanceAdminDetailDto {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  status: AssistanceStatus;
  severity: AssistanceGravite | null;
  userId: string;
  userEmail: string | null;
  userRole: string | null;
  fleetId: string | null;
  fleetName: string | null;
  escalatedAt: string | null;
  escalatedReason: string | null;
  reviewedAt: string | null;
  reviewedByEmail: string | null;
  reviewNote: string | null;
  costEur: number;
  messages: AssistanceAdminMessageDto[];
}

/** Marquer une conversation comme relue, avec la correction à retenir. */
export interface ReviewAssistanceDto {
  /** Ce que l'agent aurait dû répondre, ou ce qui manquait à sa connaissance. */
  note?: string;
  /** Clore la conversation en même temps. */
  clore?: boolean;
}

/** Réponse d'un conseiller humain dans la conversation. */
export interface AssistanceAdminReplyDto {
  message: string;
}
