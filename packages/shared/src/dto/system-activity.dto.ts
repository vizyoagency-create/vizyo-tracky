/**
 * Journal des actions AUTOMATIQUES / système (arrière-plan) — vue admin.
 *
 * Distinct de UserActivity (actions MANUELLES capturées côté front : clics,
 * scrolls, soumissions). Alimenté CÔTÉ SERVEUR par les primitives d'envoi
 * (e-mail / SMS / push), les commandes moteur, la purge de rétention et les
 * rapports IA planifiés — c.-à-d. « ce que fait l'application toute seule ».
 */

export type SystemActivityCategory =
  | 'EMAIL'
  | 'SMS'
  | 'PUSH'
  | 'ENGINE'
  | 'RETENTION'
  | 'AI_REPORT'
  | 'SURVEILLANCE'
  | 'TRACKER_CMD'
  | 'EXPORT'
  | 'SIM'
  | 'AI'
  | 'AUDIO'
  | 'INTERNAL'
  | 'MUTATION'
  /** 29/09 — gestes sur les réservations (demande, création, validation, refus, modification, réaffectation, réorganisation). */
  | 'RESERVATION'
  /** 29/09 — gestes d'agenda hors réservation (maintenance, incident, clôture, propositions de l'agent, parc, réglages). */
  | 'AGENDA';

export type SystemActivityStatus = 'SUCCESS' | 'FAILURE' | 'SKIPPED';

export interface SystemActivityDto {
  id: string;
  createdAt: string;
  category: SystemActivityCategory | string;
  action: string;
  status: SystemActivityStatus | string;
  /** Acteur d'origine : 'system' | 'planning' | nom d'un cron | nom d'utilisateur. */
  actor: string | null;
  /** Cible lisible (destinataire masqué, plaque véhicule, résumé…). */
  target: string | null;
  /** Détail lisible (sujet d'e-mail, motif, compteur…). */
  detail: string | null;
  fleetId: string | null;
  fleetName: string | null;
  /** Renseigné si l'action découle d'un acte manuel ; null = purement auto/système. */
  triggeredByUserId: string | null;
  triggeredByName: string | null;
  durationMs: number | null;
  /** Cause d'échec (extraite de meta.error) — renseignée surtout quand status = FAILURE. */
  error: string | null;
}

/** Libellés lisibles des catégories (affichage admin). */
export const SYSTEM_ACTIVITY_CATEGORY_LABELS: Record<string, string> = {
  EMAIL: 'E-mail',
  SMS: 'SMS',
  PUSH: 'Notification push',
  ENGINE: 'Commande moteur',
  RETENTION: 'Rétention / purge',
  AI_REPORT: 'Rapport IA',
  SURVEILLANCE: 'Surveillance antivol',
  TRACKER_CMD: 'Commande boîtier',
  EXPORT: 'Export de données',
  SIM: 'Carte SIM',
  AI: 'Appel IA',
  AUDIO: 'Écoute audio',
  INTERNAL: 'Provisioning interne',
  MUTATION: 'Action métier (API)',
  RESERVATION: 'Réservation',
  AGENDA: 'Agenda',
};

/**
 * 29/09 — une ligne du fil « Agenda » de la page Activité d'un administrateur de flotte
 * (`GET /api/fleet-admin/activity/agenda`). Lue dans le journal métier (catégories RESERVATION et
 * AGENDA, plus les passages de l'agent), bornée à SA société.
 *
 * ⚠️ Jamais d'identifiant d'utilisateur, jamais `actor` ni `meta` : `actorName` est calculé côté
 * serveur. Un geste d'un super-admin ou du propriétaire de la plateforme s'affiche « Équipe Tracky »
 * (l'action est visible, l'identité jamais — règle « owner caché »).
 */
export interface FleetAgendaActivityDto {
  id: string;
  /** ISO. */
  at: string;
  category: 'RESERVATION' | 'AGENDA' | 'AI' | string;
  action: string;
  /** Libellé lisible de l'action (« Réservation validée », « Incident signalé »…). */
  actionLabel: string;
  status: SystemActivityStatus | string;
  /** Nom de la personne, « Équipe Tracky », « Demande publique » ou « Agent de l'agenda ». */
  actorName: string;
  actorKind: 'user' | 'team' | 'public' | 'agent' | 'system';
  vehiclePlate: string | null;
  detail: string | null;
}

/** Libellés des actions du fil Agenda (client et admin). Une action absente s'affiche par son code. */
export const AGENDA_ACTIVITY_ACTION_LABELS: Record<string, string> = {
  reservation_demandee: 'Demande de réservation',
  reservation_creee: 'Réservation créée',
  reservation_consignee: 'Réservation consignée (déjà effectuée)',
  reservation_validee: 'Réservation validée',
  reservation_refusee: 'Demande refusée',
  /** Revue du 29/09 — l'auteur d'une demande en attente la retire lui-même : ce n'est pas un refus. */
  reservation_retiree: 'Demande retirée par son auteur',
  reservation_annulee: 'Réservation annulée',
  reservation_modifiee: 'Réservation modifiée',
  reservation_reaffectee: 'Réservation réaffectée',
  reservation_decalee: 'Réservation décalée',
  reservation_scindee: 'Réservation scindée',
  reservations_reorganisees: 'Réorganisation appliquée',
  public_booking_submitted: 'Demande reçue par le lien public',
  evenement_cree: 'Événement créé',
  incident_signale: 'Incident signalé',
  evenement_modifie: 'Événement modifié',
  evenement_clos: 'Événement clos',
  evenement_supprime: 'Événement supprimé',
  proposition_reservee: "Proposition de l'agent réservée",
  proposition_ecartee: "Proposition de l'agent écartée",
  agenda_agent_run: "Passage de l'agent",
  sieges_modifies: 'Sièges auto modifiés',
  capacites_appliquees: 'Capacités du parc appliquées',
  /** Revue du 29/09 — places ou équipements d'un véhicule changés à la main (vue Parc, fiche). */
  capacites_modifiees: "Capacités d'un véhicule modifiées",
  plan_entretien_modifie: "Plan d'entretien modifié",
  reglages_agent_modifies: "Réglages de l'agent modifiés",
};

/** Mot de statut d'une ligne d'agenda quand le geste n'a PAS pleinement abouti. */
export interface StatutActionAgenda {
  mot: string;
  ton: 'alerte' | 'attente' | 'inactif';
}

/**
 * Le statut d'une ligne d'agenda ; null = réussi, rien à dire. Partagé par la page Activité du
 * client et l'onglet Système de l'admin (revue du 29/09 : l'admin disait « ignoré » là où le client
 * disait « Avec refus » pour la même ligne).
 *
 * `SKIPPED` ne veut pas dire la même chose selon l'action qui l'écrit :
 *  · `reservations_reorganisees` : AU MOINS UNE ligne du lot a été refusée — les autres ONT été
 *    reprises (« 3 reprise(s) sur 5, 2 refus ») → « Avec refus » ;
 *  · le reste (`capacites_appliquees`…) : rien n'a été écrit → « Sans effet ».
 */
export function statutActionAgenda(status: string, action: string): StatutActionAgenda | null {
  if (status === 'FAILURE') return { mot: 'Échec', ton: 'alerte' };
  if (status === 'SKIPPED') {
    return action === 'reservations_reorganisees'
      ? { mot: 'Avec refus', ton: 'attente' }
      : { mot: 'Sans effet', ton: 'inactif' };
  }
  return null;
}
