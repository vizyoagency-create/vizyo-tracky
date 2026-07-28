/**
 * CENTRE DE NOTIFICATIONS — contrat partagé API ↔ écran d'administration (SUPER_ADMIN).
 *
 * Ce contrat existe pour répondre à UNE question, celle qu'on n'a pas su trancher pendant
 * des semaines : « est-ce que la notification est partie, et sinon POURQUOI ? »
 *
 * Le bug d'origine (582 alertes en 7 jours, zéro push) était invisible : rien ne partait,
 * rien ne le disait. On le répare — mais si on se contente de ça, on remplace un silence
 * par un autre : les garde-fous anti-spam retiennent volontairement des notifications
 * (préférence, seuil, plafond horaire), et sans écran qui les montre, un utilisateur qui
 * ne reçoit rien serait tout aussi incapable de savoir si c'est normal.
 *
 * D'où la règle qui structure tout ce fichier : **une notification RETENUE est une donnée
 * de premier plan, exactement comme une notification envoyée.** Les statuts SUPPRESSED et
 * GROUPED ne sont pas des non-événements à filtrer, ce sont des lignes à afficher avec
 * leur raison lisible.
 *
 * Les volumes réels (mesurés en production le 2026-07-27, sur 30 jours) expliquent les
 * bornes imposées ici :
 *   POWER_CUT 9 903 (330/j) · OVERSPEED 4 933 (164/j) · GEOFENCE 54 · GPS_LOST 14
 *   LOW_BATTERY 4 (par AN) · SOS 3 (par AN)
 * Soit ~500 alertes par jour × N destinataires : la table des envois est la plus
 * volumineuse du produit après les positions. Aucune lecture ne doit pouvoir la parcourir
 * sans période ni pagination — d'où `MAX_*` ci-dessous, appliqués côté serveur et pas
 * seulement suggérés au client.
 */

import type { AlertSeverity, AlertType } from './alert.dto';

// ─── Bornes de lecture ───────────────────────────────────────────────────────────────

/** Taille de page par défaut du journal des envois. */
export const NOTIFICATION_PAGE_SIZE = 50;

/**
 * Taille de page MAXIMALE. Plafond dur : à 330 POWER_CUT/jour × plusieurs destinataires,
 * un client qui demanderait « tout » ramènerait des dizaines de milliers de lignes, avec
 * leur `body` complet. Le plafond est appliqué par le serveur, jamais négocié.
 */
export const NOTIFICATION_MAX_PAGE_SIZE = 200;

/** Fenêtre par défaut : 7 jours, l'horizon utile pour « pourquoi je n'ai rien reçu hier ». */
export const NOTIFICATION_DEFAULT_WINDOW_DAYS = 7;

/**
 * Fenêtre MAXIMALE. 90 jours couvre largement le besoin d'analyse ; au-delà, la requête
 * n'utilise plus utilement l'index `(createdAt)` et l'écran devient illisible de toute façon.
 */
export const NOTIFICATION_MAX_WINDOW_DAYS = 90;

/** Nombre de destinataires remontés dans le classement de la synthèse. */
export const NOTIFICATION_TOP_RECIPIENTS = 10;

// ─── Vocabulaire ─────────────────────────────────────────────────────────────────────

/**
 * Issue d'un envoi.
 *   SENT       — au moins un appareil a accepté.
 *   FAILED     — tentative réelle, tous les appareils ont échoué.
 *   SUPPRESSED — volontairement non envoyée (préférence, seuil, périmètre, plafond).
 *   GROUPED    — repliée dans un envoi précédent (anti-spam), avec le compte.
 *
 * ⚠️ FAILED et SUPPRESSED ne se soignent PAS pareil : le premier est une panne à corriger,
 * le second est le système qui fait son travail. Les confondre dans un unique « non reçu »
 * ferait chercher une panne là où il n'y en a pas — et l'inverse.
 */
export type NotificationDeliveryStatus = 'SENT' | 'FAILED' | 'SUPPRESSED' | 'GROUPED';

export const NOTIFICATION_DELIVERY_STATUSES: readonly NotificationDeliveryStatus[] = [
  'SENT',
  'FAILED',
  'SUPPRESSED',
  'GROUPED',
];

/** Libellés FR des issues — source unique pour l'API et l'écran. */
export const NOTIFICATION_STATUS_LABELS: Record<NotificationDeliveryStatus, string> = {
  SENT: 'Envoyée',
  FAILED: 'Échec d’envoi',
  SUPPRESSED: 'Retenue',
  GROUPED: 'Regroupée',
};

/**
 * Canaux journalisés. Aujourd'hui seul WEB_PUSH est instrumenté ; les autres sont prévus
 * pour que l'ajout d'un canal ne demande pas de changer le contrat.
 *
 * ⚠️ Les garde-fous anti-spam ne s'appliquent QU'AU PUSH. EMAIL / WHATSAPP / SMS coûtent
 * de l'argent réel et gardent leur comportement : ce centre les OBSERVE, il ne les pilote pas.
 */
export type NotificationChannel = 'WEB_PUSH' | 'EMAIL' | 'WHATSAPP' | 'SMS' | 'IN_APP';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  'WEB_PUSH',
  'EMAIL',
  'WHATSAPP',
  'SMS',
  'IN_APP',
];

/**
 * Libellés FR des canaux. `WEB_PUSH` est un identifiant de colonne, pas un mot de la langue :
 * l'afficher tel quel dans un écran français est exactement le défaut « identifiant brut à
 * l'écran ». Les libellés vivent ici, avec ceux des statuts, pour que l'API et la PWA ne
 * puissent pas raconter deux choses différentes du même canal.
 */
export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  WEB_PUSH: 'Push navigateur',
  EMAIL: 'E-mail',
  WHATSAPP: 'WhatsApp',
  SMS: 'SMS',
  IN_APP: 'Dans l’application',
};

/**
 * Libellés FR des sévérités.
 *
 * ⚠️ Les clés sont la forme CLIENT (minuscules) du contrat partagé ; l'enum Prisma est en
 * MAJUSCULES et se normalise à la frontière. Un `label` égal à la clé (« critical ») dans un
 * écran français serait le même défaut que ci-dessus.
 *
 * En revanche les TYPES d'alerte (`POWER_CUT`…) restent volontairement techniques dans
 * `byAlertType` : leur table de traduction existe déjà dans la PWA, et en créer une seconde
 * ici garantirait qu'elles divergent.
 */
export const NOTIFICATION_SEVERITY_LABELS: Record<AlertSeverity, string> = {
  info: 'Information',
  warning: 'Avertissement',
  critical: 'Critique',
};

// ─── Journal des envois ──────────────────────────────────────────────────────────────

/**
 * Une ligne du journal. Elle doit se lire sans aller chercher ailleurs : QUAND, QUI
 * (e-mail + rôle, pas un UUID), QUOI (le texte réellement présenté), sur quel canal, avec
 * quelle issue et — le champ qui justifie l'écran — POURQUOI quand ce n'est pas parti.
 */
export interface NotificationDeliveryRowDto {
  id: string;
  /** ISO 8601 UTC. La mise au fuseau se fait à l'affichage. */
  createdAt: string;

  /** Alerte d'origine. `null` pour un envoi de test ou hors alerte. */
  alertId: string | null;
  /** Dénormalisé : reste lisible après purge de l'alerte (rétention plus courte). */
  alertType: AlertType | string | null;
  /** Forme CLIENT (minuscules). La base stocke un texte libre, normalisé à la frontière. */
  severity: AlertSeverity | null;

  userId: string;
  /** Identité lisible du destinataire — un UUID ne permet de diagnostiquer rien du tout. */
  userEmail: string;
  userName: string | null;
  userRole: string;

  fleetId: string | null;
  /** Résolu pour l'affichage ; `null` sur un envoi cross-flotte à un SUPER_ADMIN. */
  fleetName: string | null;

  channel: NotificationChannel | string;
  status: NotificationDeliveryStatus | string;
  /** Libellé FR de l'issue, calculé côté serveur pour que l'UI n'ait pas sa propre table. */
  statusLabel: string;

  /** Code brut du motif (ex. `preference_type_muted`), utile pour filtrer/regrouper. */
  reason: string | null;
  /** Motif en clair. `null` uniquement quand la notification est réellement partie. */
  reasonLabel: string | null;

  title: string | null;
  body: string | null;

  /** Appareils ciblés / ayant accepté / en échec au moment de l'envoi. */
  deviceCount: number;
  sentCount: number;
  failedCount: number;
  /** Événements repliés dans cet envoi par l'anti-spam. 0 = envoi simple. */
  groupedCount: number;
}

/** Filtres du journal. Tout est optionnel ; le serveur applique ses bornes par défaut. */
export interface NotificationDeliveryQueryDto {
  /** Bornes ISO. Par défaut : les `NOTIFICATION_DEFAULT_WINDOW_DAYS` derniers jours. */
  from?: string;
  to?: string;
  status?: NotificationDeliveryStatus | string;
  channel?: NotificationChannel | string;
  alertType?: string;
  severity?: AlertSeverity | string;
  userId?: string;
  fleetId?: string;
  /** Motif de suppression (`reason`), pour isoler « qui a été retenu par le plafond ». */
  reason?: string;
  /** Recherche libre sur le titre, le corps et l'e-mail du destinataire. */
  search?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Page du journal. `total` est renvoyé parce que le premier réflexe devant cet écran est
 * « combien y en a-t-il en tout ? » — la réponse est le chiffre qui rend le bruit visible.
 */
export interface NotificationDeliveryPageDto {
  rows: NotificationDeliveryRowDto[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Fenêtre réellement appliquée (après bornage), pour que l'écran l'affiche sans mentir. */
  from: string;
  to: string;
}

// ─── Synthèse ────────────────────────────────────────────────────────────────────────

/** Un compte nommé (type d'alerte, canal, sévérité…). */
export interface NotificationCountDto {
  key: string;
  label: string;
  count: number;
}

/** Une raison de non-envoi et son poids — le cœur de la lecture « pourquoi si peu ? ». */
export interface NotificationSuppressionReasonDto {
  reason: string;
  label: string;
  count: number;
  /** Part parmi les notifications retenues, entre 0 et 1. */
  share: number;
}

/** Un destinataire et sa répartition — repère les comptes noyés sous le bruit. */
export interface NotificationTopRecipientDto {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  sent: number;
  failed: number;
  suppressed: number;
  grouped: number;
  total: number;
}

/**
 * Vue d'ensemble sur une période.
 *
 * Objectif explicite : une phrase suffit à comprendre l'état du système —
 * « 412 notifications · 38 envoyées · 374 retenues (dont 330 par préférence) ».
 * Cette phrase est construite par le serveur (`headline`) pour que l'écran, l'e-mail
 * de supervision et un futur export racontent tous exactement la même chose.
 */
export interface NotificationSummaryDto {
  from: string;
  to: string;
  windowDays: number;

  total: number;
  sent: number;
  failed: number;
  suppressed: number;
  grouped: number;

  /**
   * Notifications qui n'ont JAMAIS atteint un appareil parce que le système l'a décidé
   * (SUPPRESSED + GROUPED). On exclut volontairement FAILED : un échec technique n'est
   * pas une décision, et les mélanger masquerait une panne derrière un taux « normal ».
   */
  withheld: number;
  /** `withheld / total`, entre 0 et 1. 0 si aucune notification sur la période. */
  suppressionRate: number;
  /** Répartition des retenues par motif, la plus fréquente en tête. */
  byReason: NotificationSuppressionReasonDto[];

  byStatus: NotificationCountDto[];
  byChannel: NotificationCountDto[];
  bySeverity: NotificationCountDto[];
  /** Types d'alerte, du plus bruyant au moins bruyant. */
  byAlertType: NotificationCountDto[];

  topRecipients: NotificationTopRecipientDto[];

  /** Résumé en une phrase, prêt à afficher. */
  headline: string;
}

// ─── Santé de la chaîne ──────────────────────────────────────────────────────────────

/** Abonnements push agrégés par rôle : qui est réellement joignable. */
export interface NotificationRoleReachDto {
  role: string;
  /** Utilisateurs actifs de ce rôle. */
  users: number;
  /** Utilisateurs de ce rôle possédant au moins un appareil abonné. */
  usersWithDevice: number;
  /** Appareils abonnés au total pour ce rôle. */
  devices: number;
}

/** Un utilisateur éligible au push mais sans le moindre appareil abonné. */
export interface NotificationUnreachableUserDto {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

/**
 * État de la chaîne de bout en bout.
 *
 * Le trou classique que cet objet doit rendre visible : une personne **éligible**, avec des
 * préférences correctement réglées, mais qui n'a jamais autorisé les notifications dans son
 * navigateur. De son point de vue tout est vert et elle attend des alertes qui ne
 * partiront jamais — c'est exactement la forme de panne qui a coûté 7 jours de silence.
 */
export interface NotificationHealthDto {
  /** Clés VAPID présentes : sans elles, le push est en mode no-op, quoi qu'on règle. */
  vapidConfigured: boolean;
  /** Périmètre de déploiement courant (`SUPER_ADMIN_ONLY` par défaut, `ALL` = ouvert). */
  pushRollout: string;

  /** Appareils abonnés, tous rôles confondus. */
  totalDevices: number;
  /** Utilisateurs distincts possédant au moins un appareil. */
  usersWithDevice: number;
  reachByRole: NotificationRoleReachDto[];

  /** Dernier push réellement accepté par un appareil. `null` = jamais. C'est LE signal. */
  lastSuccessfulPushAt: string | null;
  /** Dernière tentative de push, réussie ou non — distingue « rien envoyé » de « rien reçu ». */
  lastAttemptAt: string | null;

  /** Utilisateurs actifs concernés par le périmètre de déploiement en cours. */
  eligibleUsers: number;
  /** Parmi eux, ceux sans aucun appareil : ils croient être notifiés et ne le sont pas. */
  eligibleWithoutDevice: number;
  /** Échantillon nominatif (borné) pour pouvoir les contacter. */
  unreachableUsers: NotificationUnreachableUserDto[];

  /** Constats bloquants formulés en clair, prêts à afficher en bandeau. */
  warnings: string[];
}
