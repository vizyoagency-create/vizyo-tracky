/**
 * CATÉGORIES DE NOTIFICATION — le socle générique.
 *
 * ── Pourquoi ce fichier existe ───────────────────────────────────────────────────────
 * Tout le système de notification était bâti autour d'UNE seule chose : l'alerte
 * véhicule. Préférences typées par `AlertType`, seuil de sévérité, anti-spam indexé sur
 * (utilisateur, type d'alerte, véhicule), journal portant `alertId`.
 *
 * Or une notification n'est pas toujours une alerte. Un rappel d'entretien n'a ni type
 * d'alerte ni sévérité ; un rapport hebdomadaire non plus. Résultat constaté le
 * 2026-07-28 : le rappel d'entretien envoyait déjà du push **en dehors** de tout le
 * système — destinataires recodés en dur, préférences ignorées (impossible de le
 * couper), anti-spam contourné, et invisible dans le centre de notifications.
 *
 * Un second chemin existait donc déjà. En ajouter d'autres (validation d'un lieu,
 * rapport hebdomadaire…) de la même façon aurait produit autant de comportements
 * divergents que de fonctionnalités — exactement l'éparpillement qu'on venait de
 * supprimer côté réglages.
 *
 * La catégorie est la clé qui permet à TOUT de passer par le même tuyau : mêmes
 * préférences, même anti-spam, même journal, même centre.
 */

/**
 * ⚠️ Ajouter une catégorie ici ne suffit PAS à la rendre visible : il faut aussi son
 * libellé dans `NOTIFICATION_CATEGORY_LABELS` et sa description dans `NOTIFICATION_CATEGORY_DESCRIPTIONS`, sans
 * quoi l'écran de réglages afficherait un identifiant brut. Les deux objets sont typés
 * `Record<NotificationCategory, …>` : le compilateur refusera un oubli.
 */
export type NotificationCategory =
  /** Alerte véhicule (excès, coupure d'alimentation, SOS…). Typée + sévérité. */
  | 'ALERT'
  /** Rappel d'échéance d'entretien. */
  | 'MAINTENANCE'
  /** Rapport périodique prêt à consulter. */
  | 'REPORT'
  /** Quelque chose attend une décision humaine (valider un lieu, une réservation…). */
  | 'VALIDATION'
  /** Information de fonctionnement adressée à l'exploitant. */
  | 'SYSTEM'
  /**
   * Assistance : une demande d'aide vient d'être ouverte, ou un conseiller a repris la main.
   *
   * Catégorie DISTINCTE de `SYSTEM` à dessein. « Un conseiller vous a répondu » n'est pas une
   * information de fonctionnement de la plateforme, et quelqu'un qui coupe le bruit système ne
   * veut sûrement pas rater la réponse à sa propre question.
   */
  | 'ASSISTANCE';

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'ALERT',
  'MAINTENANCE',
  'REPORT',
  'VALIDATION',
  'SYSTEM',
  'ASSISTANCE',
];

/** Libellés FR — jamais l'identifiant brut à l'écran. */
export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  ALERT: 'Alertes véhicule',
  MAINTENANCE: 'Entretien',
  REPORT: 'Rapports',
  VALIDATION: 'À valider',
  SYSTEM: 'Système',
  ASSISTANCE: 'Assistance',
};

/** Une phrase par catégorie : l'utilisateur doit savoir ce qu'il coupe. */
export const NOTIFICATION_CATEGORY_DESCRIPTIONS: Record<NotificationCategory, string> = {
  ALERT: 'Excès de vitesse, coupure d’alimentation, SOS… Se règle finement par type ci-dessous.',
  MAINTENANCE: 'Échéances d’entretien qui approchent.',
  REPORT: 'Rapports périodiques prêts à consulter.',
  VALIDATION: 'Ce qui attend une décision de votre part.',
  SYSTEM: 'Informations de fonctionnement de la plateforme.',
  ASSISTANCE: 'Réponses à vos demandes d’aide, et demandes ouvertes par vos utilisateurs.',
};

/**
 * Vrai si la chaîne correspond à une catégorie connue.
 * Sert aux frontières (corps de requête, ligne de journal ancienne) : une valeur
 * inconnue ne doit jamais faire planter un écran de réglages.
 */
export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Catégories coupées par DÉFAUT : aucune.
 *
 * Le bruit mesuré vient de TYPES d'alerte précis (`POWER_CUT`, `OVERSPEED`), pas de
 * familles entières — couper « Entretien » par défaut priverait d'un signal rare et utile.
 * Le filtrage fin reste donc au niveau du type, là où le volume se joue.
 */
export const DEFAULT_MUTED_CATEGORIES: readonly NotificationCategory[] = [];
