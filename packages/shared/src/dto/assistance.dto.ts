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

// ─── Ligne d'urgence WhatsApp — le signalement d'un appui ────────────────────

/**
 * L'écran d'où l'on a appuyé sur « WhatsApp » (ligne d'astreinte véhicule, 24 h/24).
 *
 * Liste FERMÉE : le serveur refuse toute autre valeur. Un libellé libre envoyé par le navigateur
 * finirait affiché tel quel dans le centre d'activité et dans une notification — une entrée non
 * fiable n'a pas à choisir les mots qu'un super-admin lira à 3 h du matin.
 */
export type UrgenceWhatsappEcran = 'assistance' | 'vehicules' | 'mise-a-jour';

export const URGENCE_WHATSAPP_ECRANS: readonly UrgenceWhatsappEcran[] = ['assistance', 'vehicules', 'mise-a-jour'];

/**
 * Où l'on était — dit en clair, ARTICLE COMPRIS : la phrase est « depuis {libellé} », et une
 * élision (« l’ ») ne va pas devant tous les mots (« depuis l’liste des véhicules »).
 */
export const URGENCE_WHATSAPP_ECRAN_LABELS: Record<UrgenceWhatsappEcran, string> = {
  assistance: 'l’écran Assistance',
  vehicules: 'la liste des véhicules',
  'mise-a-jour': 'l’écran « mise à jour en cours »',
};

/** Le nom court de l'écran — colonne « page » du centre d'activité, comme les autres gestes. */
export const URGENCE_WHATSAPP_ECRAN_PAGES: Record<UrgenceWhatsappEcran, string> = {
  assistance: 'Assistance',
  vehicules: 'Véhicules',
  'mise-a-jour': 'Mise à jour en cours',
};

/**
 * Corps de `POST /api/assistance/urgence/whatsapp` — envoyé au moment où quelqu'un ouvre la ligne
 * d'astreinte. Il ne prouve pas qu'un message a été ENVOYÉ (WhatsApp est hors de l'application) :
 * il dit que quelqu'un, devant un véhicule, a eu besoin de la ligne. C'est exactement ce qu'un
 * super-admin doit savoir tout de suite.
 */
export interface SignalUrgenceWhatsappDto {
  ecran: UrgenceWhatsappEcran;
  /** Plaque, quand l'écran la connaît (pré-remplie dans le message WhatsApp). */
  plaque?: string;
  /**
   * Âge de l'appui, en secondes, quand il n'a PAS pu partir sur le moment et qu'il est retransmis
   * plus tard. Absent : l'appui vient d'avoir lieu.
   *
   * Le cas qu'il couvre est le plus important des trois écrans : « mise à jour en cours » s'affiche
   * précisément quand l'API ne répond plus — un signalement envoyé à cet instant se perdait à coup
   * sûr. Une DURÉE et pas une heure : elle se mesure sur une seule horloge, celle du téléphone, et
   * reste juste même quand cette horloge est fausse.
   */
  retardS?: number;
}

/**
 * Au-delà, un appui retenu n'est plus retransmis : deux heures couvrent la panne la plus longue
 * vécue (56 min, le 17/09/2026) — plus tard, l'alerte n'aurait plus de sens, seulement du bruit.
 */
export const URGENCE_WHATSAPP_RETARD_MAX_S = 2 * 60 * 60;
