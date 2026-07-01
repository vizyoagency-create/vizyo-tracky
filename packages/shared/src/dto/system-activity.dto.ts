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
  | 'AI_REPORT';

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
}

/** Libellés lisibles des catégories (affichage admin). */
export const SYSTEM_ACTIVITY_CATEGORY_LABELS: Record<string, string> = {
  EMAIL: 'E-mail',
  SMS: 'SMS',
  PUSH: 'Notification push',
  ENGINE: 'Commande moteur',
  RETENTION: 'Rétention / purge',
  AI_REPORT: 'Rapport IA',
};
