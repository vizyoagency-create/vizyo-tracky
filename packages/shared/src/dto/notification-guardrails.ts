/**
 * GARDE-FOUS ANTI-SPAM du push d'alerte.
 *
 * Ces valeurs ne sont pas des réglages de confort : elles sont calibrées sur les volumes
 * RÉELS mesurés en production le 2026-07-27, sur 30 jours.
 *
 *   POWER_CUT      CRITICAL   9 903  →  330 / jour
 *   OVERSPEED      WARNING    4 933  →  164 / jour
 *   GEOFENCE_*     WARNING       54  →    2 / jour
 *   GPS_LOST       WARNING       14  →  0,5 / jour
 *   LOW_BATTERY    WARNING        4  →  4 PAR AN
 *   SOS            CRITICAL       3  →  3 PAR AN
 *
 * Deux enseignements qui dictent toute la conception :
 *
 * 1. **La sévérité seule ne protège de rien.** `POWER_CUT` est classé CRITICAL et représente
 *    à lui seul 330 notifications par jour. Un défaut « critique uniquement », qui paraît
 *    prudent, est en réalité le PIRE choix possible. Origine : la trame Coban `ac alarm` se
 *    déclenche à chaque coupure de contact sur un boîtier câblé après contact — du
 *    stationnement normal, lu comme une alarme critique. Les 9 902 lignes ont d'ailleurs été
 *    acquittées EN MASSE à la même seconde par un humain : quelqu'un balayait déjà ce bruit
 *    à la main.
 *
 * 2. **Les alertes qui comptent vraiment sont RARES.** SOS et batterie faible : 3 et 4 par AN.
 *    Elles ne seront jamais noyées par un plafond horaire — mais elles seraient invisibles
 *    au milieu de 330 fausses alarmes quotidiennes.
 *
 * D'où la stratégie : couper le bruit connu PAR TYPE, et borner le reste PAR DÉBIT.
 */

import type { AlertType } from './alert.dto';

/**
 * Types coupés PAR DÉFAUT — les deux sources de bruit mesurées.
 *
 * ⚠️ Ce n'est PAS un jugement sur leur importance : un vrai arrachement de batterie compte.
 * C'est un constat de RAPPORT SIGNAL/BRUIT. L'utilisateur les rallume en un geste depuis
 * ses réglages, et le centre de notifications montre en permanence combien d'événements ont
 * été retenus — donc rien n'est caché, c'est juste silencieux par défaut.
 */
export const DEFAULT_MUTED_TYPES: readonly AlertType[] = ['POWER_CUT', 'OVERSPEED'];

/**
 * Délai minimal entre deux push de MÊME (utilisateur, type, véhicule).
 *
 * 15 min : au-delà d'une notification par quart d'heure pour le même problème sur le même
 * véhicule, on n'informe plus, on harcèle. Les événements survenus pendant ce délai ne sont
 * pas jetés — ils sont COMPTÉS et repliés dans le push suivant (« ×4 »).
 */
export const PUSH_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Plafond ABSOLU de push par utilisateur et par heure, tous types confondus.
 *
 * 12/heure. Dernier rempart : même si l'utilisateur active tout, même si un nouveau type
 * d'alerte se met à tomber en boucle, même si un garde-fou par type est contourné par un
 * cas non prévu, son téléphone ne vibrera pas plus de 12 fois dans l'heure. Le dépassement
 * est TRACÉ (statut SUPPRESSED, raison « plafond horaire ») pour rester visible.
 */
export const PUSH_MAX_PER_HOUR = 12;

/**
 * Le plafond horaire ne doit JAMAIS retenir ces types : ils sont à la fois rarissimes
 * (quelques unités par an) et vitaux. Mieux vaut une notification de trop qu'un appel SOS
 * avalé par un compteur.
 */
export const PUSH_BYPASS_RATE_LIMIT: readonly AlertType[] = [
  'SOS',
  'ACCIDENT',
  'COLLISION',
  'TOW',
  'TAMPER',
  'ILLEGAL_IGNITION',
];

/** Vrai si ce type traverse le plafond horaire sans être retenu. */
export function bypassesRateLimit(type: AlertType): boolean {
  return PUSH_BYPASS_RATE_LIMIT.includes(type);
}

/** Motif de non-envoi — repris tel quel dans le centre de notifications. */
export type SuppressionReason =
  | 'rollout'
  | 'preference_disabled'
  | 'preference_type_muted'
  /**
   * FAMILLE coupée (entretien, rapports…). Distinct de `preference_type_muted` : ce n'est
   * pas le même réglage, et les confondre enverrait l'administrateur chercher un type
   * d'alerte coupé alors que c'est une famille entière qui l'est.
   */
  | 'preference_category_muted'
  /**
   * L'utilisateur n'a pas `alerts_view`. Distinct de tous les autres motifs : ce n'est
   * pas un choix de sa part, c'est un refus du systeme — et cela ne se corrige pas dans
   * ses reglages mais dans ses permissions.
   */
  | 'no_permission'
  /**
   * Il a le droit de voir des alertes, mais ce vehicule n'est pas dans son perimetre
   * d'acces (UserVehicleAccess). Separe de `no_permission` parce que la correction est
   * ailleurs : elargir le perimetre, pas accorder une permission.
   */
  | 'out_of_scope'
  | 'preference_severity'
  | 'cooldown'
  | 'hourly_cap'
  | 'no_device';

/** Libellés FR des motifs, source unique pour l'API et l'écran d'administration. */
export const SUPPRESSION_LABELS: Record<SuppressionReason, string> = {
  rollout: 'Push non ouvert à ce rôle',
  preference_disabled: 'Notifications désactivées par l’utilisateur',
  preference_type_muted: 'Ce type est coupé dans ses réglages',
  preference_category_muted: 'Cette famille est coupée dans ses réglages',
  no_permission: 'Pas la permission de consulter les alertes',
  out_of_scope: 'Ce véhicule est hors de son périmètre d’accès',
  preference_severity: 'Sous le seuil de sévérité choisi',
  cooldown: 'Regroupée — même alerte trop récente',
  hourly_cap: 'Plafond horaire atteint',
  no_device: 'Aucun appareil abonné',
};
