/**
 * Préférences de notification PUSH — contrat partagé API ↔ PWA.
 *
 * Le parc produit ~580 alertes WARNING par semaine (essentiellement des excès de vitesse).
 * Sans filtrage, « activer les notifications » revient à recevoir ~80 notifications par
 * jour, et l'utilisateur coupe tout au bout de deux heures. Ces préférences existent pour
 * que le push reste utilisable, pas pour faire joli dans un écran de réglages.
 */

import type { AlertSeverity, AlertType } from './alert.dto';
import type { NotificationCategory } from './notification-category';

/**
 * Ordre de sévérité — sert au filtre « à partir de ».
 *
 * ⚠️ En MINUSCULES : c'est la forme du contrat client (`AlertSeverity`). La base, elle,
 * stocke l'enum Prisma en MAJUSCULES. La conversion se fait dans la couche API, à la
 * frontière — jamais ici.
 */
export const SEVERITY_ORDER: readonly AlertSeverity[] = ['info', 'warning', 'critical'];

/**
 * Sévérité minimale par défaut quand l'utilisateur n'a JAMAIS ouvert ses réglages.
 *
 * `critical` volontairement : le défaut doit être utilisable sans réglage préalable.
 * Recevoir uniquement les alertes graves donne envie d'en ouvrir plus ; recevoir 80
 * notifications le premier jour donne envie de tout couper — et on ne revient jamais.
 */
export const DEFAULT_MIN_SEVERITY: AlertSeverity = 'critical';

/** Vrai si `severity` atteint ou dépasse le seuil `min`. */
export function meetsSeverity(severity: AlertSeverity, min: AlertSeverity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(min);
}


/**
 * Qui reçoit les alertes de la flotte, PAR DÉFAUT, quand l'utilisateur n'a rien choisi.
 *
 * Reproduit EXACTEMENT le comportement d'avant : la liste des destinataires était codée en
 * dur à « tous les FLEET_ADMIN de la flotte ». Le rendre explicite ici permet de l'ouvrir
 * sans rien déplacer : tant que personne ne touche à son réglage, les mêmes personnes
 * reçoivent les mêmes alertes.
 *
 * Constat qui a motivé l'ouverture (prod 2026-07-28) : la flotte cdef31 comptait 6
 * utilisateurs actifs et 1 seul destinataire. Un responsable d'astreinte ou un veilleur de
 * nuit ne pouvait pas être prévenu, et personne ne pouvait y remédier.
 */
export function defaultReceivesFleetAlerts(role: string): boolean {
  return role === 'FLEET_ADMIN';
}

/**
 * Résout le réglage effectif : le choix explicite s'il existe, sinon le défaut du rôle.
 * `null`/`undefined` = « jamais choisi », ce qui n'est PAS « non ».
 */
export function resolveReceivesFleetAlerts(
  explicit: boolean | null | undefined,
  role: string,
): boolean {
  return explicit ?? defaultReceivesFleetAlerts(role);
}

export interface NotificationPreferenceDto {
  /** Interrupteur MAÎTRE : `false` = plus aucun push, quels que soient les autres réglages. */
  pushEnabled: boolean;
  /** On n'envoie que les alertes de sévérité supérieure ou égale. */
  minSeverity: AlertSeverity;
  /** Types d'ALERTE explicitement coupés. Un type absent de cette liste est actif. */
  mutedTypes: AlertType[];
  /**
   * Catégories explicitement coupées ('MAINTENANCE', 'REPORT'…).
   *
   * Distinct de `mutedTypes`, qui ne concerne que les alertes véhicule : un rappel
   * d'entretien n'a ni type d'alerte ni sévérité, et devait pourtant pouvoir se couper
   * autrement qu'en supprimant TOUT le push.
   */
  mutedCategories: NotificationCategory[];
  /**
   * Vrai tant que l'utilisateur n'a jamais enregistré de réglages : l'écran peut alors
   * expliquer le défaut appliqué au lieu de le présenter comme un choix déjà fait.
   */
  isDefault: boolean;
  /**
   * Faux quand le déploiement du push est encore restreint et que ce rôle n'est pas
   * concerné. L'écran doit le DIRE — sinon l'utilisateur règle ses préférences, ne reçoit
   * rien, et conclut que la fonctionnalité est cassée.
   */
  eligible: boolean;
  /** Nombre d'appareils actuellement abonnés pour cet utilisateur. */
  deviceCount: number;
  /**
   * Reçoit-il les alertes de sa flotte ? Valeur RÉSOLUE (choix explicite, ou défaut du rôle).
   * Sans destinataire, aucun canal ne part — c'est la condition amont de tout le reste.
   */
  receivesFleetAlerts: boolean;
  /** Vrai si cette valeur vient du rôle et non d'un choix : l'écran doit pouvoir le dire. */
  receivesFleetAlertsIsDefault: boolean;
}

/** Mise à jour partielle : seuls les champs fournis sont modifiés. */
export interface UpdateNotificationPreferenceDto {
  pushEnabled?: boolean;
  /** `null` remet le réglage sur « selon mon rôle » plutôt que de forcer une valeur. */
  receivesFleetAlerts?: boolean | null;
  minSeverity?: AlertSeverity;
  mutedTypes?: AlertType[];
  mutedCategories?: NotificationCategory[];
}

/**
 * Décide si une alerte doit produire un push pour un utilisateur donné.
 *
 * Fonction PURE et PARTAGÉE : l'API l'utilise pour filtrer les envois, la PWA pour
 * afficher « vous recevrez ceci » de façon cohérente. Deux implémentations séparées
 * auraient divergé au premier changement de règle.
 */
export function shouldPushAlert(
  pref: Pick<NotificationPreferenceDto, 'pushEnabled' | 'minSeverity' | 'mutedTypes'>,
  alert: { type: AlertType; severity: AlertSeverity },
): boolean {
  if (!pref.pushEnabled) return false;
  if (pref.mutedTypes.includes(alert.type)) return false;
  return meetsSeverity(alert.severity, pref.minSeverity);
}

/**
 * Une notification, vue par le filtre de préférences — quelle que soit sa nature.
 *
 * `alertType` et `severity` ne sont renseignés que pour la catégorie `ALERT` : un rappel
 * d'entretien n'a ni l'un ni l'autre, et devait pourtant traverser le même filtre.
 */
export interface PushCandidate {
  category: NotificationCategory;
  alertType?: AlertType;
  severity?: AlertSeverity;
}

/**
 * Décide si une notification, DE N'IMPORTE QUELLE NATURE, doit produire un push.
 *
 * Généralise `shouldPushAlert`, qui exigeait un type d'alerte et une sévérité — donc
 * inutilisable pour un rappel d'entretien ou un rapport. C'est précisément pour ça que le
 * rappel d'entretien envoyait du push en DEHORS du système, sans préférence applicable.
 *
 * Ordre volontaire : interrupteur maître, puis catégorie, puis (alertes seulement) type
 * et sévérité. Une catégorie coupée l'emporte sur un réglage fin — couper « Entretien »
 * doit tout taire, sans avoir à énumérer quoi que ce soit.
 */
export function shouldPushNotification(
  pref: Pick<NotificationPreferenceDto, 'pushEnabled' | 'minSeverity' | 'mutedTypes' | 'mutedCategories'>,
  candidate: PushCandidate,
): boolean {
  if (!pref.pushEnabled) return false;
  if (pref.mutedCategories.includes(candidate.category)) return false;
  // Hors alerte : ni type ni sévérité à évaluer — la catégorie suffit.
  if (candidate.category !== 'ALERT') return true;
  if (candidate.alertType && pref.mutedTypes.includes(candidate.alertType)) return false;
  // Une alerte sans sévérité lisible est traitée comme critique : une notification de
  // trop se voit, une alerte grave avalée ne se voit pas.
  return meetsSeverity(candidate.severity ?? 'critical', pref.minSeverity);
}
