import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, AlertTriangle, BellRing, ChevronLeft, Clock, EyeOff,
  Filter, Inbox, KeyRound, Loader, RefreshCw, Search, Send, ShieldCheck, Smartphone, UserX, Users,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_SEVERITY_LABELS,
  NOTIFICATION_STATUS_LABELS,
  SUPPRESSION_LABELS,
  type NotificationChannel,
  type NotificationDeliveryRowDto,
  type NotificationDeliveryStatus,
  type NotificationHealthDto,
  type NotificationSummaryDto,
  type SuppressionReason,
} from '@vizyo/tracky-shared';
import { relativeTime } from '../../shared/utils/relative-time';
import { roleLabel } from '../../shared/utils/role-labels';
import { NotificationCenterApiService, type NotificationWindow } from '../../core/services/notification-center-api.service';

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS PURS — exportés pour être testés sans DOM (même motif que
   `notifications-card.component.ts`). Toute la logique « ce que l'écran affirme »
   vit ici : c'est elle qui doit être vraie, pas le CSS.
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Libellés FR des types d'alerte.
 *
 * L'API renvoie volontairement les CLÉS BRUTES pour `byAlertType` (`POWER_CUT`) : c'est la
 * donnée, pas l'affichage. La traduction se fait donc ici, avec exactement les mêmes mots
 * que l'écran Alertes — deux libellés divergents pour le même événement et l'admin croit
 * regarder deux choses distinctes.
 */
export const ALERT_TYPE_LABELS_FR: Record<string, string> = {
  SOS: 'SOS',
  POWER_CUT: 'Coupure d\'alimentation',
  ACCIDENT: 'Accident',
  COLLISION: 'Collision',
  LOW_BATTERY: 'Batterie faible',
  OVERSPEED: 'Excès de vitesse',
  GEOFENCE_ENTER: 'Entrée géofence',
  GEOFENCE_EXIT: 'Sortie géofence',
  MOVEMENT_IDLE: 'Mouvement à l\'arrêt',
  HARSH_BRAKING: 'Freinage brusque',
  HARSH_ACCELERATION: 'Accélération brusque',
  HARSH_TURN: 'Virage brusque',
  BONNET: 'Capot ouvert',
  DOOR: 'Porte ouverte',
  VIBRATION: 'Vibration détectée',
  TOW: 'Remorquage détecté',
  TAMPER: 'Tentative de sabotage',
  FATIGUE: 'Fatigue conducteur',
  ILLEGAL_IGNITION: 'Démarrage non autorisé',
  GPS_LOST: 'Perte du signal GPS',
  IDLE_TIME: 'Temps d\'arrêt prolongé',
  SURVEILLANCE_TRIGGERED: 'Surveillance déclenchée',
  MAINTENANCE_DUE: 'Entretien à échéance',
  UNKNOWN: 'Alerte inconnue',
};

/**
 * Dernier recours quand un identifiant inconnu arrive (type ajouté côté serveur avant
 * l'écran). On ne le jette pas — perdre l'information serait pire — mais on ne l'affiche
 * jamais tel quel : `HARSH_BRAKING` devient « Harsh braking ».
 */
export function humanizeIdentifier(raw: string): string {
  const words = raw.replace(/_/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** Libellé FR d'un type d'alerte. Jamais d'identifiant brut à l'écran. */
export function alertTypeLabel(type: string | null | undefined): string {
  if (!type) return 'Notification';
  return ALERT_TYPE_LABELS_FR[type] ?? humanizeIdentifier(type);
}

export type SeverityKey = 'info' | 'warning' | 'critical';

/**
 * Normalise une sévérité.
 *
 * ⚠️ PIÈGE ASSUMÉ DU PROJET : le contrat client est en minuscules (`critical`), l'enum
 * Prisma en MAJUSCULES (`CRITICAL`), et la colonne du journal est un TEXTE LIBRE. L'API
 * normalise déjà, mais une ligne écrite avant cette normalisation reste en base : comparer
 * sans normaliser ici afficherait « — » sur un SOS critique.
 */
export function severityKey(raw: string | null | undefined): SeverityKey | null {
  const v = (raw ?? '').toLowerCase();
  return v === 'info' || v === 'warning' || v === 'critical' ? v : null;
}

/**
 * Libellé FR d'une sévérité — table du contrat PARTAGÉ.
 *
 * Elle était recopiée ici, avec les mêmes mots. Une copie identique aujourd'hui est une
 * divergence demain : l'API sert déjà `bySeverity[].label` depuis cette même table, et deux
 * sources feraient qu'une synthèse et une carte du journal finiraient par nommer
 * différemment la MÊME ligne.
 */
export function severityLabel(raw: string | null | undefined): string {
  const key = severityKey(raw);
  return key ? NOTIFICATION_SEVERITY_LABELS[key] : '—';
}

export type StatusTone = 'sent' | 'failed' | 'suppressed' | 'grouped' | 'unknown';

/**
 * Ton visuel d'une issue.
 *
 * `SUPPRESSED` et `GROUPED` ne sont PAS des erreurs : ce sont les garde-fous qui font leur
 * travail. Les peindre en rouge apprendrait à l'admin à ignorer le rouge — et le jour où un
 * vrai `FAILED` apparaît, il ne le verrait plus.
 */
export function statusTone(status: string | null | undefined): StatusTone {
  switch (status) {
    case 'SENT': return 'sent';
    case 'FAILED': return 'failed';
    case 'SUPPRESSED': return 'suppressed';
    case 'GROUPED': return 'grouped';
    default: return 'unknown';
  }
}

/**
 * Libellé FR d'une issue — table du contrat PARTAGÉ, jamais une copie locale. L'API pose
 * déjà `statusLabel` sur chaque ligne ; cette fonction sert de repli et pour les agrégats.
 */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return 'Inconnue';
  const known: string | undefined = NOTIFICATION_STATUS_LABELS[status as NotificationDeliveryStatus];
  return known ?? humanizeIdentifier(status);
}

/**
 * Libellé FR d'un motif de non-envoi. Source : le contrat PARTAGÉ (`SUPPRESSION_LABELS`),
 * pour que l'API et l'écran disent exactement la même phrase — sinon le diagnostic dépend
 * de l'endroit où on le lit.
 */
export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return '';
  // Typage explicite : la table ne couvre que les motifs CONNUS ; un motif ajouté côté
  // serveur avant l'écran vaut `undefined` à l'exécution, quoi qu'en dise le `Record`.
  const known: string | undefined = SUPPRESSION_LABELS[reason as SuppressionReason];
  return known ?? humanizeIdentifier(reason);
}

/**
 * Canaux — AFFICHAGE seulement. Les canaux payants (e-mail / WhatsApp / SMS) sont observés
 * ici, jamais pilotés : les garde-fous anti-spam ne concernent que le push.
 *
 * La table vient du contrat PARTAGÉ. Une table locale existait, et elle divergeait DÉJÀ
 * (« Push » ici, « Push navigateur » dans `byChannel` servi par l'API) : le même canal
 * portait deux noms sur le même écran selon l'endroit où on le lisait.
 */
export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return '—';
  const known: string | undefined = NOTIFICATION_CHANNEL_LABELS[channel as NotificationChannel];
  return known ?? humanizeIdentifier(channel);
}

/**
 * Libellé FR d'un rôle, sans jamais laisser passer un identifiant brut.
 *
 * `roleLabel` (util partagé de la PWA) renvoie la valeur TELLE QUELLE quand le rôle est
 * inconnu — ce qui afficherait `INCONNU` (le rôle posé par l'API sur une ligne dont le
 * compte a été supprimé) en capitales au milieu d'un écran français. On repasse donc par
 * `humanizeIdentifier` : « Inconnu ».
 */
export function roleText(role: string | null | undefined): string {
  if (!role) return '';
  const label = roleLabel(role);
  return label === role ? humanizeIdentifier(role) : label;
}

/** Libellé FR du périmètre de déploiement en cours (`PUSH_ROLLOUT` côté serveur). */
export function rolloutLabel(rollout: string | null | undefined): string {
  if (rollout === 'ALL') return 'Tous les rôles';
  if (rollout === 'SUPER_ADMIN_ONLY') return 'Super-administrateurs seulement';
  return rollout ? humanizeIdentifier(rollout) : 'Inconnu';
}

/** Un rôle est-il DANS le périmètre de déploiement actuel ? */
export function isRoleInScope(role: string, rollout: string | null | undefined): boolean {
  return rollout === 'ALL' || role === 'SUPER_ADMIN';
}

export type HealthLevel = 'ok' | 'warn' | 'down' | 'unknown';

export interface HealthVerdict {
  level: HealthLevel;
  title: string;
  detail: string;
}

/**
 * Au-delà de ce délai sans AUCUN push réussi, on lève un doute — sans crier à la panne.
 *
 * 7 jours : les alertes qui franchissent les garde-fous sont rares par construction (SOS :
 * 3 par an, batterie faible : 4 par an). Un silence de quelques jours peut être parfaitement
 * normal. D'où un verdict qui dit « à vérifier » et pas « cassé » — c'est l'excès de
 * confiance dans le silence qui a laissé le push mort pendant des mois.
 */
export const STALE_PUSH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Verdict de santé — la phrase qui doit répondre à « est-ce que ça marche ? » en 2 secondes.
 *
 * L'ordre va du plus bloquant au plus subtil : un seul message s'affiche, ce doit être LE
 * plus actionnable.
 *   1. pas de VAPID → rien ne peut partir, tout le reste est du bruit ;
 *   2. personne dans le périmètre → le déploiement est fermé sur du vide ;
 *   3. personne de joignable → cas vicieux : des appareils EXISTENT mais appartiennent à des
 *      rôles hors périmètre. L'écran afficherait « 12 appareils abonnés », tout paraîtrait
 *      sain, et aucun push n'atteindrait jamais un téléphone ;
 *   4. jamais confirmé / rien depuis longtemps → doute, pas verdict.
 *
 * L'API fournit aussi `warnings[]` : ils sont affichés EN PLUS, pas à la place. Ce verdict
 * porte la couleur et la phrase d'accroche, eux portent le détail.
 */
export function healthVerdict(h: NotificationHealthDto | null, nowMs: number = Date.now()): HealthVerdict {
  if (!h) {
    return { level: 'unknown', title: 'État inconnu', detail: 'La santé du push n\'a pas encore été chargée.' };
  }
  if (!h.vapidConfigured) {
    return {
      level: 'down',
      title: 'Push hors service',
      detail: 'Les clés VAPID manquent côté serveur : aucun appareil ne peut être joint, quels que soient les réglages des utilisateurs.',
    };
  }
  if (h.eligibleUsers === 0) {
    return {
      level: 'down',
      title: 'Aucun compte dans le périmètre',
      detail: `Le périmètre en cours (${rolloutLabel(h.pushRollout).toLowerCase()}) ne couvre aucun compte : il n'y a personne à notifier.`,
    };
  }
  if (h.eligibleWithoutDevice >= h.eligibleUsers) {
    return {
      level: 'down',
      title: 'Aucun destinataire joignable',
      detail: h.totalDevices > 0
        ? `${h.totalDevices} appareil(s) sont abonnés, mais aucun n'appartient à un compte du périmètre (${rolloutLabel(h.pushRollout).toLowerCase()}). Rien n'arrivera sur un téléphone.`
        : 'Aucun compte du périmètre n\'a d\'appareil abonné : il faut activer les notifications sur au moins un appareil.',
    };
  }
  if (!h.lastSuccessfulPushAt) {
    return {
      level: 'warn',
      title: 'Jamais confirmé',
      detail: 'La chaîne est en place mais aucun push réussi n\'a encore été enregistré. Un envoi de test depuis Diagnostic & Tests lève le doute en une minute.',
    };
  }
  const last = Date.parse(h.lastSuccessfulPushAt);
  if (Number.isFinite(last) && nowMs - last > STALE_PUSH_MS) {
    return {
      level: 'warn',
      title: 'Aucun envoi récent',
      detail: 'Rien n\'est parti depuis plus de 7 jours. Ce n\'est pas forcément une panne — les alertes qui franchissent les garde-fous sont rares — mais un envoi de test le confirmerait.',
    };
  }
  return {
    level: 'ok',
    title: 'Le push fonctionne',
    detail: `Clés VAPID en place, ${h.totalDevices} appareil(s) abonné(s), et un envoi a réussi récemment.`,
  };
}

/**
 * Part des notifications RETENUES, en pourcentage entier.
 *
 * L'API expose `suppressionRate` entre 0 et 1 et exclut volontairement les échecs : une
 * panne technique n'est pas une décision du système. On se contente de convertir — recalculer
 * ici ferait diverger l'écran du chiffre servi à l'API et à un futur e-mail de supervision.
 */
export function withheldPct(s: NotificationSummaryDto | null): number {
  if (!s) return 0;
  const rate = Number.isFinite(s.suppressionRate) ? s.suppressionRate : 0;
  return Math.max(0, Math.min(100, Math.round(rate * 100)));
}

/**
 * Ce que le motif DOMINANT veut réellement dire.
 *
 * Le cas par défaut (absent de cette table) est la coupure par type : là, un taux élevé est
 * bien la protection anti-bruit qui fonctionne. Tous les autres motifs racontent autre
 * chose — et surtout `no_device`, qui signifie « ce compte n'a aucun appareil abonné »,
 * c'est-à-dire un destinataire INJOIGNABLE et non un destinataire protégé. Confondre les
 * deux serait rejouer la faute d'origine : habiller un silence subi en fonctionnement normal.
 */
const DOMINANT_REASON_NOTES: Record<string, string> = {
  no_device:
    'Ces notifications n\'ont pas été filtrées : leurs destinataires n\'ont aucun appareil abonné. '
    + 'Ce ne sont pas des comptes protégés du bruit, ce sont des comptes injoignables — la liste nominative est dans le bandeau de santé.',
  hourly_cap:
    'Le plafond de 12 push par heure et par personne a été atteint : un type d\'alerte tombe en rafale. '
    + 'Le plafond a joué son rôle de dernier rempart, mais la source du volume, elle, reste à traiter.',
  cooldown:
    'Ces événements ne sont pas perdus : ils ont été repliés dans le push suivant (« ×N ») parce qu\'une alerte identique '
    + 'venait de partir pour le même véhicule, il y a moins de 15 minutes.',
  preference_disabled:
    'Ce sont des comptes qui ont coupé eux-mêmes leurs notifications : un choix explicite, rien à corriger côté système.',
  preference_severity:
    'Ces alertes sont passées sous le seuil de sévérité choisi par leurs destinataires. Rien n\'est cassé : c\'est le réglage qui s\'applique.',
};

/**
 * Phrase qui accompagne le taux de filtrage.
 *
 * Un taux élevé EST le régime normal quand il vient des réglages : `POWER_CUT` (330/jour,
 * du stationnement lu comme alarme critique) et `OVERSPEED` (164/jour) sont coupés par
 * défaut. Présenté sèchement, « 94 % retenues » ressemble à une panne — et quelqu'un
 * finirait par « réparer » le garde-fou.
 *
 * ⚠️ Mais l'inverse est un piège aussi grave : afficher « c'est le fonctionnement attendu »
 * au-dessus d'un mur de `no_device` ferait passer pour une protection le fait que PERSONNE
 * n'est joignable. On ne conclut donc « attendu » qu'en regardant le motif RÉELLEMENT
 * dominant, jamais par défaut.
 */
export function protectionNote(s: NotificationSummaryDto | null): string {
  if (!s || s.total === 0) return 'Aucune notification sur la période.';
  if (s.withheld === 0) return 'Aucune notification retenue : tout ce qui a été produit est parti.';

  const pct = withheldPct(s);
  const top = reasonRows(s)[0];
  const specific = top ? DOMINANT_REASON_NOTES[top.key] : undefined;
  if (top && specific) {
    return `${pct} % des notifications ont été retenues, principalement pour un motif : `
      + `${top.label.toLowerCase()} (${top.count}, soit ${top.pct} % des retenues). ${specific}`;
  }

  // Motif dominant = un réglage utilisateur (ou aucune répartition renvoyée) : c'est le cas
  // nominal, on explique le volume évité pour que personne ne « corrige » le garde-fou.
  return `${pct} % des notifications ont été retenues — c'est le fonctionnement attendu : `
    + 'les deux types les plus bruyants (coupure d\'alimentation, excès de vitesse) sont coupés par défaut. '
    + 'Sans ce filtre, près de 500 notifications par jour arriveraient sur les téléphones.';
}

/* ── Clés de SYNTHÈSE qui ne sont pas des valeurs de FILTRE ─────────────────────────────
 *
 * La synthèse de l'API remplace les colonnes nulles par une étiquette lisible : un envoi
 * sans alerte est compté sous `'hors alerte'`, une retenue sans motif enregistré sous
 * `'inconnu'` (voir `notification-center.service.ts`, `byAlertType` / `byReason`). Ces deux
 * chaînes n'existent nulle part en base : les renvoyer au journal comme filtre donnerait
 * TOUJOURS zéro ligne.
 *
 * Or l'écran affiche à côté un compteur non nul. Un admin verrait donc « 12 » puis, en
 * cliquant, « aucune notification pour ces filtres » — une contradiction, sur le seul écran
 * dont le métier est de ne pas mentir. Ces barres restent affichées (le volume est vrai),
 * mais elles ne sont pas cliquables et ne sont pas proposées dans les menus.
 */
const NON_FILTERABLE_TYPE_KEYS: readonly string[] = ['hors alerte'];
const NON_FILTERABLE_REASON_KEYS: readonly string[] = ['inconnu'];

export interface ReasonRow {
  key: string;
  label: string;
  count: number;
  /** Part parmi les retenues, en pourcentage entier. */
  pct: number;
  /** Faux pour une étiquette de synthèse qui ne correspond à aucune valeur stockée. */
  filterable: boolean;
}

/** Motifs de non-envoi, du plus fréquent au moins fréquent, avec leur part. */
export function reasonRows(s: NotificationSummaryDto | null): ReasonRow[] {
  if (!s) return [];
  return s.byReason
    .filter((r) => r.count > 0)
    .map((r) => ({
      key: r.reason,
      // L'API fournit déjà le libellé FR ; le repli couvre une réponse partielle.
      label: r.label || reasonLabel(r.reason),
      count: r.count,
      pct: Math.round((Number.isFinite(r.share) ? r.share : 0) * 100),
      filterable: !NON_FILTERABLE_REASON_KEYS.includes(r.reason),
    }))
    .sort((a, b) => b.count - a.count);
}

export interface TypeRow {
  key: string;
  label: string;
  count: number;
  /** Largeur de barre, relative au type le plus volumineux. */
  pct: number;
  /** Faux pour une étiquette de synthèse qui ne correspond à aucune valeur stockée. */
  filterable: boolean;
}

/**
 * Volumétrie par type d'alerte, traduite en français.
 *
 * L'API renvoie les clés brutes (`POWER_CUT`, ou `hors alerte` pour les envois sans alerte) :
 * la barre est donc calculée par rapport au PLUS GROS type, ce qui met immédiatement en
 * évidence les deux sources de bruit connues.
 */
export function typeRows(s: NotificationSummaryDto | null): TypeRow[] {
  if (!s) return [];
  const rows = s.byAlertType.filter((t) => t.count > 0);
  const max = rows.reduce((m, t) => Math.max(m, t.count), 0);
  return rows
    .map((t) => ({
      key: t.key,
      label: alertTypeLabel(t.key),
      count: t.count,
      pct: max > 0 ? Math.max(2, Math.round((t.count / max) * 100)) : 0,
      filterable: !NON_FILTERABLE_TYPE_KEYS.includes(t.key),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Ligne de contexte d'une livraison : ce qui s'est réellement passé côté appareils.
 * Volontairement factuelle — c'est ce qui transforme « je n'ai rien reçu » en diagnostic.
 */
export function deliveryDetail(d: NotificationDeliveryRowDto): string {
  const parts: string[] = [];
  if (d.status === 'SENT') {
    parts.push(d.deviceCount > 0 ? `${d.sentCount}/${d.deviceCount} appareil(s)` : `${d.sentCount} appareil(s)`);
    if (d.failedCount > 0) parts.push(`${d.failedCount} en échec`);
  } else if (d.status === 'FAILED') {
    parts.push(d.deviceCount > 0 ? `0/${d.deviceCount} appareil(s)` : 'aucun appareil joint');
  }
  if (d.groupedCount > 0) parts.push(`${d.groupedCount} événement(s) repliés`);
  return parts.join(' · ');
}

/** Nom affichable d'un destinataire — jamais un UUID, qui ne diagnostique rien. */
export function recipientName(who: { name?: string | null; userName?: string | null; email?: string | null; userEmail?: string | null }): string {
  return who.name || who.userName || who.email || who.userEmail || 'Compte supprimé';
}

export interface NotificationPreview {
  title: string;
  body: string;
  at: string | null;
  /** Vrai si l'aperçu vient d'une vraie notification partie, faux si c'est un exemple. */
  real: boolean;
}

/**
 * Aperçu de ce que l'utilisateur voit sur son téléphone : la DERNIÈRE notification
 * réellement envoyée, prise telle quelle — même si son texte est pauvre. Un push parti avec
 * un titre vide est précisément ce que l'admin doit voir, pas ce qu'on doit maquiller.
 */
export function previewFrom(rows: NotificationDeliveryRowDto[]): NotificationPreview {
  const last = rows.find((r) => r.status === 'SENT');
  if (!last) {
    return {
      title: 'Aucune notification envoyée',
      body: 'L\'aperçu reprendra le contenu du dernier push réellement parti.',
      at: null,
      real: false,
    };
  }
  return {
    title: last.title?.trim() || alertTypeLabel(last.alertType),
    body: last.body?.trim() || '',
    at: last.createdAt,
    real: true,
  };
}

/**
 * Concatène la page suivante SANS jamais répéter une ligne déjà affichée.
 *
 * Le journal est trié `createdAt desc` et paginé par OFFSET : si une ligne s'insère en tête
 * entre deux pages, tout glisse d'un cran et la page suivante renvoie une ligne déjà à
 * l'écran. Ce n'est pas une hypothèse d'école — la table grossit d'environ 500 alertes par
 * jour × N destinataires, soit plusieurs lignes par minute. Or `@for … track d.id` fait
 * tomber la vue entière (NG0955) sur une clé dupliquée : la page de supervision
 * disparaîtrait au moment précis où l'admin cherche quelque chose.
 *
 * La fenêtre de lecture est gelée par ailleurs (voir `range` dans le composant), ce qui
 * empêche la cause ; ce filtre est la ceinture par-dessus la bretelle, parce que le coût
 * d'un doublon est un écran blanc.
 */
export function mergePages(
  existing: NotificationDeliveryRowDto[],
  incoming: NotificationDeliveryRowDto[],
): NotificationDeliveryRowDto[] {
  if (existing.length === 0) return [...incoming];
  const seen = new Set(existing.map((r) => r.id));
  return [...existing, ...incoming.filter((r) => !seen.has(r.id))];
}

/** Circonférence du cercle de la jauge (rayon 18 dans un viewBox 44×44). */
export const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 18;

/**
 * `stroke-dasharray` de l'anneau de progression.
 *
 * Un anneau SVG plutôt qu'un `conic-gradient` piloté par variable CSS : la valeur passe par
 * un attribut SVG standard, sans dépendre du support des propriétés personnalisées dans les
 * liaisons de style — et elle reste vérifiable par un test.
 */
export function gaugeDash(pct: number): string {
  const safe = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return `${((safe / 100) * GAUGE_CIRCUMFERENCE).toFixed(2)} ${GAUGE_CIRCUMFERENCE.toFixed(2)}`;
}

type WindowKey = '24h' | '7d' | '30d';

/** Fenêtre ISO correspondant à un raccourci d'affichage. */
export function windowRange(days: number, nowMs: number = Date.now()): NotificationWindow {
  return {
    from: new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(nowMs).toISOString(),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════ */

/**
 * CENTRE DE NOTIFICATIONS (SUPER_ADMIN) — « voir toutes les notifs, à qui, quand, envoyé ».
 *
 * Raison d'être : pendant des mois, 582 alertes par semaine ont produit ZÉRO push sans que
 * personne ne s'en aperçoive, faute d'un endroit où le constater. Cet écran montre donc
 * autant les envois QUE les non-envois, avec leur motif — remplacer un silence invisible par
 * un autre serait pire que le bug d'origine.
 *
 * Trois niveaux de lecture, du plus rapide au plus détaillé :
 *   1. bandeau de santé  → « est-ce que ça marche ? » en 2 secondes ;
 *   2. totaux + motifs   → « pourquoi si peu part ? » (réponse : les garde-fous, et c'est bien) ;
 *   3. journal filtrable → « et pour CETTE personne, à CETTE heure ? ».
 */
@Component({
  selector: 'app-admin-notifications',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, DecimalPipe, LucideAngularModule],
  template: `
    <div class="nc">
      <a routerLink="/admin" class="nc-back"><lucide-icon [img]="BackIcon" [size]="15"></lucide-icon> Administration</a>

      <header class="nc-head">
        <div class="nc-title">
          <div class="nc-ico"><lucide-icon [img]="BellIcon" [size]="22"></lucide-icon></div>
          <div>
            <h1>Centre de notifications</h1>
            <p>Ce qui est parti, ce qui a été retenu, et à qui — {{ windowLabel() }}.</p>
          </div>
        </div>
        <div class="nc-actions">
          <div class="nc-seg">
            @for (w of windows; track w.key) {
              <button type="button" (click)="setWindow(w.key)" [class.on]="windowKey() === w.key">{{ w.label }}</button>
            }
          </div>
          <label class="nc-auto" [class.nc-auto--on]="autoRefresh()" title="Rafraîchissement automatique (30 s)">
            <input type="checkbox" [checked]="autoRefresh()" (change)="toggleAuto($any($event.target).checked)">
            <span class="nc-auto-dot"></span> Auto
          </label>
          <button type="button" class="nc-refresh" (click)="reload()" [disabled]="loading()" aria-label="Rafraîchir">
            <lucide-icon [img]="RefreshIcon" [size]="15" [class.nc-spin]="loading()"></lucide-icon>
          </button>
        </div>
      </header>

      @if (error()) {
        <div class="nc-alert"><lucide-icon [img]="AlertIcon" [size]="15"></lucide-icon> {{ error() }}</div>
      }

      <!-- ════════════ 1) BANDEAU DE SANTÉ ════════════ -->
      @if (health(); as h) {
        <section class="nc-health" [attr.data-level]="verdict().level">
          <div class="nc-health-head">
            <span class="nc-health-dot"></span>
            <div class="nc-health-txt">
              <h2>{{ verdict().title }}</h2>
              <p>{{ verdict().detail }}</p>
            </div>
          </div>

          <div class="nc-tiles">
            <div class="nc-tile" [class.nc-tile--bad]="!h.vapidConfigured">
              <span class="nc-tile-l"><lucide-icon [img]="KeyIcon" [size]="12"></lucide-icon> Clés VAPID</span>
              <span class="nc-tile-v">{{ h.vapidConfigured ? 'En place' : 'Absentes' }}</span>
            </div>
            <div class="nc-tile">
              <span class="nc-tile-l"><lucide-icon [img]="ShieldIcon" [size]="12"></lucide-icon> Périmètre</span>
              <span class="nc-tile-v nc-tile-v--sm">{{ rolloutLabel(h.pushRollout) }}</span>
            </div>
            <div class="nc-tile" [class.nc-tile--bad]="h.totalDevices === 0">
              <span class="nc-tile-l"><lucide-icon [img]="PhoneIcon" [size]="12"></lucide-icon> Appareils abonnés</span>
              <span class="nc-tile-v">{{ h.totalDevices | number:'1.0-0' }}</span>
              <span class="nc-tile-sub">{{ h.usersWithDevice | number:'1.0-0' }} compte(s)</span>
            </div>
            <div class="nc-tile">
              <span class="nc-tile-l"><lucide-icon [img]="ClockIcon" [size]="12"></lucide-icon> Dernier push réussi</span>
              <span class="nc-tile-v nc-tile-v--sm">{{ h.lastSuccessfulPushAt ? relativeTime(h.lastSuccessfulPushAt) : 'Jamais' }}</span>
              @if (h.lastAttemptAt) {
                <!-- Distingue « rien envoyé » de « rien reçu » : une tentative récente sans
                     succès ne se soigne pas comme une absence totale de tentative. -->
                <span class="nc-tile-sub">dernière tentative {{ relativeTime(h.lastAttemptAt) }}</span>
              }
            </div>
            <!-- Le chiffre qui compte : des comptes autorisés mais injoignables sont
                 exactement le trou qui reste invisible pendant des mois. -->
            <div class="nc-tile" [class.nc-tile--bad]="h.eligibleWithoutDevice > 0">
              <span class="nc-tile-l"><lucide-icon [img]="UserXIcon" [size]="12"></lucide-icon> Éligibles sans appareil</span>
              <span class="nc-tile-v">{{ h.eligibleWithoutDevice | number:'1.0-0' }}</span>
              <span class="nc-tile-sub">sur {{ h.eligibleUsers | number:'1.0-0' }} dans le périmètre</span>
            </div>
          </div>

          <!-- Constats formulés par le serveur, affichés EN PLUS du verdict : lui porte la
               couleur et la phrase d'accroche, eux le détail. Suivi par index — deux constats
               identiques ne doivent pas faire tomber la vue sur une clé dupliquée. -->
          @for (w of h.warnings; track $index) {
            <p class="nc-health-note"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ w }}</p>
          }

          @if (h.unreachableUsers.length > 0) {
            <div class="nc-roles">
              <span class="nc-roles-l"><lucide-icon [img]="UserXIcon" [size]="12"></lucide-icon> Comptes autorisés sans aucun appareil</span>
              <div class="nc-chips">
                @for (u of h.unreachableUsers; track u.userId) {
                  <span class="nc-rolechip nc-rolechip--out" [title]="u.email">
                    {{ recipientName(u) }}
                    <em>{{ roleText(u.role) }}</em>
                  </span>
                }
              </div>
            </div>
          }

          @if (h.reachByRole.length > 0) {
            <div class="nc-roles">
              <span class="nc-roles-l"><lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon> Abonnements par rôle</span>
              <div class="nc-chips">
                @for (r of h.reachByRole; track r.role) {
                  <span class="nc-rolechip" [class.nc-rolechip--out]="!isRoleInScope(r.role, h.pushRollout)"
                        [title]="isRoleInScope(r.role, h.pushRollout) ? 'Dans le périmètre de déploiement' : 'Hors périmètre : ces appareils ne reçoivent rien'">
                    {{ roleText(r.role) }}
                    <b>{{ r.usersWithDevice | number:'1.0-0' }}/{{ r.users | number:'1.0-0' }}</b>
                    <span class="nc-rolechip-d">{{ r.devices | number:'1.0-0' }} appareil(s)</span>
                    @if (!isRoleInScope(r.role, h.pushRollout)) { <em>hors périmètre</em> }
                  </span>
                }
              </div>
            </div>
          }
        </section>
      } @else if (loading()) {
        <div class="nc-skel nc-skel--tall"></div>
      }

      <!-- ════════════ 2) TOTAUX ════════════ -->
      @if (summary(); as s) {
        <section class="nc-kpis">
          <div class="nc-kpi nc-kpi--sent">
            <span class="nc-kpi-n">{{ s.sent | number:'1.0-0' }}</span>
            <span class="nc-kpi-l"><lucide-icon [img]="SendIcon" [size]="12"></lucide-icon> Envoyées</span>
          </div>
          <div class="nc-kpi">
            <span class="nc-kpi-n">{{ s.suppressed | number:'1.0-0' }}</span>
            <span class="nc-kpi-l"><lucide-icon [img]="EyeOffIcon" [size]="12"></lucide-icon> Retenues</span>
          </div>
          <div class="nc-kpi">
            <span class="nc-kpi-n">{{ s.grouped | number:'1.0-0' }}</span>
            <span class="nc-kpi-l"><lucide-icon [img]="InboxIcon" [size]="12"></lucide-icon> Regroupées</span>
          </div>
          <!-- Seul l'échec est peint en rouge : c'est la seule anomalie réelle des quatre. -->
          <div class="nc-kpi" [class.nc-kpi--bad]="s.failed > 0">
            <span class="nc-kpi-n">{{ s.failed | number:'1.0-0' }}</span>
            <span class="nc-kpi-l"><lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon> Échecs</span>
          </div>
        </section>

        <section class="nc-panel">
          <div class="nc-protect">
            <div class="nc-protect-gauge">
              <svg class="nc-gauge" viewBox="0 0 44 44" aria-hidden="true">
                <circle class="nc-gauge-bg" cx="22" cy="22" r="18"></circle>
                <circle class="nc-gauge-fg" cx="22" cy="22" r="18" [attr.stroke-dasharray]="gaugeDash(withheldPct(s))"></circle>
              </svg>
              <span class="nc-protect-pct">{{ withheldPct(s) }}%</span>
              <span class="nc-protect-cap">filtrées</span>
            </div>
            <div class="nc-protect-txt">
              <h2><lucide-icon [img]="ShieldIcon" [size]="15"></lucide-icon> Les garde-fous font leur travail</h2>
              <!-- Phrase construite par le serveur : l'écran, un futur e-mail de supervision
                   et un export doivent raconter la même chose, au mot près. -->
              @if (s.headline) { <p class="nc-headline">{{ s.headline }}</p> }
              <p>{{ protectionNote(s) }}</p>
            </div>
          </div>
        </section>

        <div class="nc-split">
          <!-- Répartition des motifs de suppression -->
          <section class="nc-panel">
            <div class="nc-panel-head"><h2><lucide-icon [img]="EyeOffIcon" [size]="15"></lucide-icon> Pourquoi elles ne sont pas parties</h2></div>
            @if (reasons().length === 0) {
              <p class="nc-empty">Aucune notification retenue sur la période.</p>
            } @else {
              <div class="nc-bars">
                @for (r of reasons(); track r.key) {
                  <!-- Une étiquette de synthèse (« Motif non renseigné ») n'existe pas comme
                       valeur en base : la proposer au clic afficherait un journal vide sous
                       un compteur non nul. On garde la barre, on retire le clic. -->
                  <button type="button" class="nc-brow" [class.on]="fReason() === r.key" (click)="setReason(r.key)"
                          [disabled]="!r.filterable"
                          [title]="r.filterable ? 'Filtrer le journal sur : ' + r.label : 'Ce regroupement n’est pas un filtre : ces lignes n’ont pas de motif enregistré.'">
                    <span class="nc-brow-top">
                      <span class="nc-brow-l">{{ r.label }}</span>
                      <span class="nc-brow-n">{{ r.count | number:'1.0-0' }} <em>{{ r.pct }}%</em></span>
                    </span>
                    <span class="nc-bar"><span class="nc-bar-fill" [style.width.%]="r.pct"></span></span>
                  </button>
                }
              </div>
              <p class="nc-hint">Part de chaque motif parmi les notifications retenues. Cliquer filtre le journal.</p>
            }
          </section>

          <!-- Aperçu de ce que reçoit l'utilisateur + volumétrie par type -->
          <section class="nc-panel">
            <div class="nc-panel-head"><h2><lucide-icon [img]="BellIcon" [size]="15"></lucide-icon> Sur le téléphone</h2></div>
            <!-- Les deux images sont celles réellement utilisées par le service worker
                 (public/sw.js : icon '/pwa-icon-192.png', badge '/notification-badge-96.png').
                 Un aperçu qui pointerait ailleurs mentirait sur le rendu réel. -->
            <div class="nc-preview" [class.nc-preview--demo]="!preview().real">
              <div class="nc-preview-head">
                <img src="/notification-badge-96.png" alt="" width="14" height="14" class="nc-preview-badge">
                <span>Vizyo Tracky</span>
                @if (preview().at; as at) { <span class="nc-preview-when">· {{ relativeTime(at) }}</span> }
              </div>
              <div class="nc-preview-body">
                <div class="nc-preview-txt">
                  <strong>{{ preview().title }}</strong>
                  @if (preview().body) { <span>{{ preview().body }}</span> }
                </div>
                <img src="/pwa-icon-192.png" alt="" width="38" height="38" class="nc-preview-icon">
              </div>
            </div>
            @if (!preview().real) {
              <p class="nc-hint">Aucun push envoyé sur la période — l'aperçu se remplira au premier envoi.</p>
            }

            @if (types().length > 0) {
              <div class="nc-typelist">
                @for (t of types(); track t.key) {
                  <!-- Idem : « Hors alerte » est une étiquette de synthèse, pas un type
                       stocké. Cliquable, elle promettrait un filtre qui ne rend rien. -->
                  <button type="button" class="nc-type" [class.on]="fType() === t.key" (click)="setType(t.key)"
                          [disabled]="!t.filterable"
                          [title]="t.filterable ? 'Filtrer le journal sur : ' + t.label : 'Regroupement des envois sans alerte : pas de filtre correspondant.'">
                    <span class="nc-type-l">{{ t.label }}</span>
                    <span class="nc-type-bar"><span class="nc-type-fill" [style.width.%]="t.pct"></span></span>
                    <span class="nc-type-n">{{ t.count | number:'1.0-0' }}</span>
                  </button>
                }
              </div>
              <p class="nc-hint">Volume produit par type d'alerte, tous statuts confondus.</p>
            }
          </section>
        </div>

        <!-- Destinataires : le « à qui » -->
        @if (s.topRecipients.length > 0) {
          <section class="nc-panel">
            <div class="nc-panel-head"><h2><lucide-icon [img]="UsersIcon" [size]="15"></lucide-icon> Qui a reçu quoi</h2></div>
            <div class="nc-people">
              @for (p of s.topRecipients; track p.userId) {
                <button type="button" class="nc-person" [class.on]="fUserId() === p.userId" (click)="setUser(p.userId)"
                        [title]="p.email">
                  <span class="nc-person-id">
                    <span class="nc-person-n">{{ recipientName(p) }}</span>
                    <span class="nc-person-r">{{ roleText(p.role) }}</span>
                  </span>
                  <span class="nc-person-k">
                    <span class="nc-pk nc-pk--sent">{{ p.sent | number:'1.0-0' }} envoyée(s)</span>
                    @if (p.suppressed + p.grouped > 0) { <span class="nc-pk">{{ p.suppressed + p.grouped | number:'1.0-0' }} retenue(s)</span> }
                    @if (p.failed > 0) { <span class="nc-pk nc-pk--bad">{{ p.failed | number:'1.0-0' }} échec(s)</span> }
                  </span>
                </button>
              }
            </div>
          </section>
        }
      } @else if (loading()) {
        <div class="nc-skel"></div>
      }

      <!-- ════════════ 3) JOURNAL ════════════ -->
      <section class="nc-panel">
        <div class="nc-panel-head">
          <h2>
            <lucide-icon [img]="InboxIcon" [size]="15"></lucide-icon> Journal des notifications
            @if (total() > 0) { <span class="nc-count">{{ total() | number:'1.0-0' }} ligne(s)</span> }
          </h2>
          @if (activeFilters() > 0) {
            <button type="button" class="nc-clear" (click)="clearFilters()">Effacer les filtres ({{ activeFilters() }})</button>
          }
        </div>

        <!-- ⚠️ [selected] sur CHAQUE option, et surtout pas [value] sur le select :
             Angular applique la valeur du select AVANT que les options d'un @for existent,
             le navigateur ignore l'affectation et la liste retombe sur son premier choix
             (« Toutes »). Le journal resterait filtré pendant que le menu afficherait le
             contraire — piège déjà payé ailleurs dans le produit. Ici il se déclencherait
             au moindre filtre posé depuis une barre, ou dès qu'un type disparaît des
             données de la période et que typeOptions le réinjecte. -->
        <div class="nc-filters">
          <label class="nc-field">
            <span><lucide-icon [img]="FilterIcon" [size]="12"></lucide-icon> Issue</span>
            <select (change)="setStatus($any($event.target).value)">
              <option value="" [selected]="fStatus() === ''">Toutes</option>
              @for (st of statuses; track st) {
                <option [value]="st" [selected]="fStatus() === st">{{ statusLabel(st) }}</option>
              }
            </select>
          </label>
          <label class="nc-field">
            <span>Famille</span>
            <select (change)="setCategory($any($event.target).value)">
              <option value="" [selected]="fCategory() === ''">Toutes</option>
              @for (c of categoryOptions; track c.key) {
                <option [value]="c.key" [selected]="fCategory() === c.key">{{ c.label }}</option>
              }
            </select>
          </label>
          <label class="nc-field">
            <span>Type d'alerte</span>
            <select (change)="setType($any($event.target).value)">
              <option value="" [selected]="fType() === ''">Tous</option>
              @for (t of typeOptions(); track t.key) {
                <option [value]="t.key" [selected]="fType() === t.key">{{ t.label }}</option>
              }
            </select>
          </label>
          <label class="nc-field">
            <span>Sévérité</span>
            <select (change)="setSeverity($any($event.target).value)">
              <option value="" [selected]="fSeverity() === ''">Toutes</option>
              <option value="critical" [selected]="fSeverity() === 'critical'">Critique</option>
              <option value="warning" [selected]="fSeverity() === 'warning'">Avertissement</option>
              <option value="info" [selected]="fSeverity() === 'info'">Information</option>
            </select>
          </label>
          <label class="nc-field">
            <span>Motif de non-envoi</span>
            <select (change)="setReason($any($event.target).value)">
              <option value="" [selected]="fReason() === ''">Tous</option>
              @for (r of reasonOptions(); track r.key) {
                <option [value]="r.key" [selected]="fReason() === r.key">{{ r.label }}</option>
              }
            </select>
          </label>
          <label class="nc-field nc-field--grow">
            <span><lucide-icon [img]="SearchIcon" [size]="12"></lucide-icon> Recherche</span>
            <input type="search" [value]="fSearch()" (input)="setSearch($any($event.target).value)"
                   placeholder="Titre, message ou e-mail du destinataire">
          </label>
        </div>

        @if (fUserId()) {
          <p class="nc-hint nc-hint--filter">
            Filtré sur un destinataire.
            <button type="button" class="nc-linkbtn" (click)="setUser('')">Voir tout le monde</button>
          </p>
        }

        <!-- Cartes empilées à toutes les tailles : une ligne de journal porte huit
             informations, un tableau les rendrait illisibles sur téléphone — or c'est
             souvent depuis son téléphone qu'on vient vérifier une notification. -->
        <div class="nc-log">
          @for (d of rows(); track d.id) {
            <article class="nc-card" [attr.data-tone]="statusTone(d.status)">
              <div class="nc-card-top">
                <span class="nc-badge"><span class="nc-badge-dot"></span>{{ d.statusLabel || statusLabel(d.status) }}</span>
                <span class="nc-chan">{{ channelLabel(d.channel) }}</span>
                <!-- Affichee uniquement hors alerte : sur un journal encore compose a
                     99 % d'alertes, une pastille « Alertes vehicule » sur chaque ligne
                     serait du bruit — alors qu'un rappel d'entretien perdu au milieu
                     doit sauter aux yeux. -->
                @if (d.category && d.category !== 'ALERT') {
                  <span class="nc-cat">{{ d.categoryLabel || d.category }}</span>
                }
                @if (severityKey(d.severity); as sev) {
                  <span class="nc-sev" [attr.data-sev]="sev">{{ severityLabel(d.severity) }}</span>
                }
                <span class="nc-when" [title]="(d.createdAt | date:'dd/MM/yyyy HH:mm:ss') || ''">
                  {{ d.createdAt | date:'dd/MM HH:mm' }}
                </span>
              </div>

              <!-- Hors alerte, le type est vide et le titre retombait sur un generique
                   « Notification » : la famille dit au moins de quoi il s'agit. -->
              <h3 class="nc-card-title">{{ d.alertType ? alertTypeLabel(d.alertType) : (d.categoryLabel || 'Notification') }}</h3>
              @if (d.title || d.body) {
                <p class="nc-card-msg">{{ d.title }}@if (d.title && d.body) { <span> — </span> }{{ d.body }}</p>
              }

              <div class="nc-card-who">
                <span class="nc-who">
                  <lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon>
                  {{ recipientName(d) }}
                  @if (d.userRole) { <em>{{ roleText(d.userRole) }}</em> }
                </span>
                @if (d.fleetName) { <span class="nc-fleet">{{ d.fleetName }}</span> }
              </div>

              @if (d.reasonLabel || d.reason || deliveryDetail(d)) {
                <div class="nc-card-foot">
                  @if (d.reasonLabel || d.reason) {
                    <span class="nc-reason">{{ d.reasonLabel || reasonLabel(d.reason) }}</span>
                  }
                  @if (deliveryDetail(d); as det) { <span class="nc-detail">{{ det }}</span> }
                </div>
              }

              <!--
                RENVOYER — visible uniquement sur une ligne RETENUE et rattachée à une
                alerte. C'est là que la question se pose : « il n'a rien reçu, et
                maintenant ? » Jusqu'ici la réponse était « rien », parce que l'endpoint
                de rejeu n'existait pas et que le seul envoi de test est verrouillé sur
                son propre compte.

                ⚠️ Pas de bouton sur une ligne SENT : renvoyer ce qui est déjà parti n'a
                pas de sens, et l'offrir inviterait à le faire.
              -->
              @if (d.alertId && d.status !== 'SENT') {
                <div class="nc-card-foot nc-card-replay">
                  <button
                    type="button"
                    class="nc-replay-btn"
                    [disabled]="replayingId() === d.id"
                    (click)="onReplay(d)"
                  >
                    @if (replayingId() === d.id) {
                      <lucide-icon [img]="LoaderIcon" [size]="12" class="nc-spin"></lucide-icon> Envoi…
                    } @else {
                      Renvoyer
                    }
                  </button>
                  @if (replayResult()[d.id]; as res) {
                    <span class="nc-replay-res">{{ res }}</span>
                  }
                </div>
              }
            </article>
          } @empty {
            <p class="nc-empty">
              {{ loading() ? 'Chargement…' : (activeFilters() > 0 ? 'Aucune notification pour ces filtres.' : 'Aucune notification enregistrée sur la période.') }}
            </p>
          }
        </div>

        @if (hasMore()) {
          <button type="button" class="nc-more" (click)="loadMore()" [disabled]="loadingMore()">
            @if (loadingMore()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="nc-spin"></lucide-icon> } Charger plus
          </button>
        }
      </section>
    </div>
  `,
  styles: [`
    .nc-card-replay { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .nc-replay-btn {
      font-size: .7rem; padding: .2rem .55rem; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--fg-secondary);
      display: inline-flex; align-items: center; gap: .3rem;
    }
    .nc-replay-btn:hover:not(:disabled) { color: var(--fg-primary); border-color: var(--fg-tertiary); }
    .nc-replay-btn:disabled { opacity: .6; cursor: default; }
    .nc-replay-res { font-size: .68rem; color: var(--fg-tertiary); }
    .nc { max-width: 1120px; display: flex; flex-direction: column; gap: 16px; }
    .nc-back { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--fg-tertiary); text-decoration: none; width: fit-content; }
    .nc-back:hover { color: var(--fg-secondary); }

    .nc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .nc-title { display: flex; align-items: center; gap: 12px; }
    .nc-ico { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: rgba(16,224,160,.12); color: var(--tracky-light, #10E0A0); flex-shrink: 0; }
    .nc-head h1 { font-family: var(--font-display, Manrope, sans-serif); font-size: 24px; font-weight: 800; color: var(--fg-primary); margin: 0; }
    .nc-head p { font-size: 12.5px; color: var(--fg-tertiary); margin: 3px 0 0; }
    .nc-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

    .nc-seg { display: inline-flex; background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 3px; gap: 2px; }
    .nc-seg button { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 7px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); background: transparent; border: 0; cursor: pointer; }
    .nc-seg button.on { background: var(--bg-tertiary); color: var(--fg-primary); }

    .nc-auto { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-tertiary); font-size: 12px; font-weight: 600; cursor: pointer; user-select: none; }
    .nc-auto input { position: absolute; opacity: 0; width: 0; height: 0; }
    .nc-auto-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-tertiary); }
    .nc-auto--on { border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 45%, transparent); color: var(--fg-secondary); }
    .nc-auto--on .nc-auto-dot { background: var(--tracky-light, #10E0A0); animation: nc-pulse 1.6s ease-in-out infinite; }
    @keyframes nc-pulse { 50% { opacity: .35; } }

    .nc-refresh { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); cursor: pointer; }
    .nc-refresh:disabled { opacity: .6; }
    .nc-alert { display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-radius: 11px; background: rgba(239,68,68,.1); color: #EF4444; font-size: 13px; }

    /* ── Bandeau de santé ── */
    .nc-health { padding: 18px 20px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 14px; position: relative; overflow: hidden; }
    .nc-health::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--tone, #94a3b8); }
    .nc-health[data-level="ok"]      { --tone: #10E0A0; }
    .nc-health[data-level="warn"]    { --tone: #fbbf24; }
    .nc-health[data-level="down"]    { --tone: #f87171; }
    .nc-health[data-level="unknown"] { --tone: #94a3b8; }
    .nc-health-head { display: flex; align-items: flex-start; gap: 12px; }
    .nc-health-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--tone); margin-top: 5px; flex-shrink: 0; box-shadow: 0 0 0 4px color-mix(in srgb, var(--tone) 18%, transparent); }
    .nc-health[data-level="ok"] .nc-health-dot { animation: nc-beat 2.4s ease-in-out infinite; }
    @keyframes nc-beat { 50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--tone) 0%, transparent); } }
    .nc-health-txt h2 { font-family: var(--font-display, Manrope, sans-serif); font-size: 17px; font-weight: 800; color: var(--tone); margin: 0; }
    .nc-health-txt p { font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); margin: 4px 0 0; max-width: 68ch; }
    .nc-health-note { display: flex; align-items: flex-start; gap: 7px; font-size: 12px; line-height: 1.5; color: #fbbf24; margin: 0; padding: 9px 11px; border-radius: 10px; background: rgba(251,191,36,.09); }

    .nc-tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
    .nc-tile { padding: 11px 13px; border-radius: 12px; background: var(--bg-tertiary); display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .nc-tile-l { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); font-weight: 700; }
    .nc-tile-v { font-family: var(--font-display, Manrope, sans-serif); font-size: 20px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; line-height: 1.15; }
    .nc-tile-v--sm { font-size: 13.5px; font-weight: 700; line-height: 1.35; }
    .nc-tile-sub { font-size: 11px; color: var(--fg-tertiary); }
    .nc-tile--bad { background: rgba(239,68,68,.08); }
    .nc-tile--bad .nc-tile-v { color: #f87171; }

    .nc-roles { display: flex; flex-direction: column; gap: 7px; }
    .nc-roles-l { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); font-weight: 700; }
    .nc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .nc-rolechip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .nc-rolechip b { font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .nc-rolechip-d { font-size: 11px; color: var(--fg-tertiary); }
    .nc-rolechip em { font-style: normal; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; padding: 1px 6px; border-radius: 5px; background: rgba(251,191,36,.16); color: #fbbf24; }

    /* ── KPIs ── */
    .nc-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .nc-kpi { padding: 14px 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 3px; }
    .nc-kpi-n { font-family: var(--font-display, Manrope, sans-serif); font-size: 24px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .nc-kpi-l { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); font-weight: 600; }
    .nc-kpi--sent .nc-kpi-n { color: var(--tracky-light, #10E0A0); }
    .nc-kpi--bad { border-color: rgba(239,68,68,.4); background: rgba(239,68,68,.05); }
    .nc-kpi--bad .nc-kpi-n { color: #f87171; }

    /* ── Panneaux ── */
    .nc-panel { padding: 16px 18px; border-radius: 16px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 12px; }
    .nc-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .nc-panel-head h2 { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .nc-count { font-size: 11.5px; font-weight: 600; color: var(--fg-tertiary); padding: 2px 8px; border-radius: 999px; background: var(--bg-tertiary); }
    .nc-split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
    .nc-empty { font-size: 12.5px; color: var(--fg-tertiary); padding: 14px 0; text-align: center; margin: 0; }
    .nc-hint { font-size: 11.5px; color: var(--fg-tertiary); margin: 0; }
    .nc-hint--filter { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .nc-linkbtn { background: none; border: 0; padding: 0; color: var(--tracky-light, #10E0A0); font-size: 11.5px; font-weight: 700; cursor: pointer; text-decoration: underline; }
    .nc-clear { padding: 6px 11px; border-radius: 9px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); font-size: 12px; font-weight: 600; cursor: pointer; }

    /* ── Taux de filtrage (présenté comme une protection, pas comme une panne) ── */
    .nc-protect { display: flex; align-items: center; gap: 18px; }
    .nc-protect-gauge { width: 96px; height: 96px; flex-shrink: 0; position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .nc-gauge { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
    .nc-gauge circle { fill: none; stroke-width: 5; }
    .nc-gauge-bg { stroke: var(--bg-tertiary); }
    .nc-gauge-fg { stroke: var(--tracky-light, #10E0A0); stroke-linecap: round; transition: stroke-dasharray .5s; }
    .nc-protect-pct { position: relative; z-index: 1; font-family: var(--font-display, Manrope, sans-serif); font-size: 22px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .nc-protect-cap { position: relative; z-index: 1; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--fg-tertiary); font-weight: 700; }
    .nc-protect-txt h2 { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .nc-protect-txt p { font-size: 12.5px; line-height: 1.55; color: var(--fg-secondary); margin: 5px 0 0; max-width: 62ch; }
    .nc-headline { font-weight: 700; color: var(--fg-primary) !important; }

    /* ── Barres des motifs ── */
    .nc-bars { display: flex; flex-direction: column; gap: 8px; }
    .nc-brow { display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 7px 9px; border-radius: 10px; background: transparent; border: 1px solid transparent; cursor: pointer; text-align: left; }
    .nc-brow:hover { background: var(--bg-tertiary); }
    .nc-brow.on { background: var(--bg-tertiary); border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 40%, transparent); }
    .nc-brow-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .nc-brow-l { font-size: 12.5px; font-weight: 600; color: var(--fg-secondary); }
    .nc-brow-n { font-size: 12.5px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .nc-brow-n em { font-style: normal; font-weight: 600; color: var(--fg-tertiary); font-size: 11px; margin-left: 4px; }
    .nc-bar { display: block; height: 6px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; }
    .nc-brow:hover .nc-bar, .nc-brow.on .nc-bar { background: color-mix(in srgb, var(--fg-tertiary) 18%, transparent); }
    .nc-bar-fill { display: block; height: 100%; border-radius: 999px; background: #a78bfa; transition: width .4s; }

    /* Barres non filtrables (étiquettes de synthèse) : elles restent lisibles — leur volume
       est une vraie information — mais ne se comportent pas comme un bouton, pour ne pas
       promettre un filtre qui rendrait un journal vide. */
    .nc-brow:disabled, .nc-type:disabled { cursor: default; }
    .nc-brow:disabled:hover, .nc-type:disabled:hover { background: transparent; }
    .nc-brow:disabled:hover .nc-bar, .nc-type:disabled:hover .nc-type-bar { background: var(--bg-tertiary); }

    /* ── Aperçu notification (icônes réelles du service worker) ── */
    .nc-preview { border-radius: 14px; padding: 11px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 7px; }
    .nc-preview--demo { opacity: .7; }
    .nc-preview-head { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: var(--fg-tertiary); }
    .nc-preview-badge { opacity: .75; border-radius: 3px; }
    .nc-preview-when { font-weight: 500; }
    .nc-preview-body { display: flex; align-items: flex-start; gap: 12px; }
    .nc-preview-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .nc-preview-txt strong { font-size: 13px; font-weight: 700; color: var(--fg-primary); }
    .nc-preview-txt span { font-size: 12px; line-height: 1.45; color: var(--fg-secondary); }
    .nc-preview-icon { border-radius: 9px; flex-shrink: 0; }

    /* ── Volumétrie par type ── */
    .nc-typelist { display: flex; flex-direction: column; gap: 3px; }
    .nc-type { display: grid; grid-template-columns: minmax(0, 1fr) 78px auto; align-items: center; gap: 10px; width: 100%; padding: 6px 8px; border-radius: 9px; background: transparent; border: 1px solid transparent; cursor: pointer; text-align: left; }
    .nc-type:hover { background: var(--bg-tertiary); }
    .nc-type.on { background: var(--bg-tertiary); border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 40%, transparent); }
    .nc-type-l { font-size: 12px; color: var(--fg-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nc-type-bar { display: block; height: 6px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; }
    .nc-type:hover .nc-type-bar, .nc-type.on .nc-type-bar { background: color-mix(in srgb, var(--fg-tertiary) 18%, transparent); }
    .nc-type-fill { display: block; height: 100%; border-radius: 999px; background: #60a5fa; }
    .nc-type-n { font-size: 11.5px; font-weight: 800; color: var(--fg-primary); font-variant-numeric: tabular-nums; }

    /* ── Destinataires ── */
    .nc-people { display: flex; flex-direction: column; gap: 4px; }
    .nc-person { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 9px 11px; border-radius: 11px; background: transparent; border: 1px solid transparent; cursor: pointer; text-align: left; }
    .nc-person:hover { background: var(--bg-tertiary); }
    .nc-person.on { background: var(--bg-tertiary); border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 40%, transparent); }
    .nc-person-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .nc-person-n { font-size: 13px; font-weight: 700; color: var(--fg-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nc-person-r { font-size: 11px; color: var(--fg-tertiary); }
    .nc-person-k { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
    .nc-pk { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-tertiary); white-space: nowrap; }
    .nc-person:hover .nc-pk, .nc-person.on .nc-pk { background: color-mix(in srgb, var(--fg-tertiary) 16%, transparent); }
    .nc-pk--sent { background: rgba(16,224,160,.14); color: var(--tracky-light, #10E0A0); }
    .nc-pk--bad { background: rgba(239,68,68,.13); color: #f87171; }

    /* ── Filtres ── */
    .nc-cat { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--surface-2, #f1f5f9); color: var(--text-2, #475569); }
    .nc-filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
    .nc-field { display: flex; flex-direction: column; gap: 4px; }
    .nc-field--grow { flex: 1 1 220px; }
    .nc-field > span { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--fg-tertiary); font-weight: 600; }
    .nc-field select, .nc-field input { padding: 8px 10px; border-radius: 9px; background: var(--bg-primary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 12.5px; font-family: inherit; min-width: 150px; }
    .nc-field input { width: 100%; }

    /* ── Journal (cartes empilées) ── */
    .nc-log { display: flex; flex-direction: column; gap: 8px; }
    .nc-card { position: relative; padding: 12px 14px 12px 16px; border-radius: 13px; background: var(--bg-tertiary); display: flex; flex-direction: column; gap: 6px; }
    .nc-card::before { content: ''; position: absolute; top: 10px; bottom: 10px; left: 0; width: 3px; border-radius: 0 3px 3px 0; background: var(--tone, #94a3b8); }
    .nc-card[data-tone="sent"]       { --tone: #10E0A0; }
    .nc-card[data-tone="failed"]     { --tone: #f87171; }
    .nc-card[data-tone="suppressed"] { --tone: #a78bfa; }
    .nc-card[data-tone="grouped"]    { --tone: #60a5fa; }
    .nc-card[data-tone="unknown"]    { --tone: #94a3b8; }

    .nc-card-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .nc-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 800; padding: 3px 9px; border-radius: 999px; color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent); }
    .nc-badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .nc-chan { font-size: 10.5px; font-weight: 700; padding: 2px 7px; border-radius: 6px; background: var(--bg-secondary); color: var(--fg-tertiary); }
    .nc-sev { font-size: 10.5px; font-weight: 800; padding: 2px 7px; border-radius: 6px; text-transform: uppercase; letter-spacing: .03em; }
    .nc-sev[data-sev="critical"] { background: rgba(239,68,68,.14); color: #f87171; }
    .nc-sev[data-sev="warning"]  { background: rgba(251,191,36,.14); color: #fbbf24; }
    .nc-sev[data-sev="info"]     { background: rgba(96,165,250,.14); color: #60a5fa; }
    .nc-when { margin-left: auto; font-size: 11.5px; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }

    .nc-card-title { font-size: 13.5px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .nc-card-msg { font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); margin: 0; }
    .nc-card-who { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .nc-who { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fg-secondary); }
    .nc-who em { font-style: normal; font-size: 11px; color: var(--fg-tertiary); }
    .nc-who em::before { content: '· '; }
    .nc-fleet { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--bg-secondary); color: var(--fg-tertiary); }
    .nc-card-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 2px; }
    .nc-reason { font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px; background: color-mix(in srgb, var(--tone) 13%, transparent); color: var(--tone); }
    .nc-detail { font-size: 11.5px; color: var(--fg-tertiary); }

    .nc-more { align-self: center; margin-top: 4px; padding: 9px 16px; border-radius: 9px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); color: var(--fg-secondary); font-size: 12.5px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    .nc-more:disabled { opacity: .6; }

    .nc-skel { height: 96px; border-radius: 16px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: nc-sh 1.3s infinite; }
    .nc-skel--tall { height: 190px; }
    @keyframes nc-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .nc-spin { animation: nc-spin 1s linear infinite; }
    @keyframes nc-spin { to { transform: rotate(360deg); } }

    /* ── Adaptations écran étroit ── */
    @media (max-width: 900px) {
      .nc-tiles { grid-template-columns: repeat(3, 1fr); }
      .nc-split { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .nc-head h1 { font-size: 21px; }
      .nc-tiles { grid-template-columns: 1fr 1fr; }
      .nc-kpis { grid-template-columns: 1fr 1fr; }
      .nc-protect { flex-direction: column; align-items: flex-start; gap: 14px; }
      .nc-person { flex-direction: column; align-items: flex-start; gap: 6px; }
      .nc-person-k { justify-content: flex-start; }
      .nc-field { flex: 1 1 100%; }
      .nc-field select, .nc-field input { width: 100%; min-width: 0; }
      .nc-when { margin-left: 0; width: 100%; }

      /* Cibles tactiles : 44 px minimum (Apple HIG / Material). En dessous, l'utilisateur
         rate le bouton deux ou trois fois — retour déjà constaté sur les anciennes cibles
         36 px du shell. */
      .nc-seg button, .nc-refresh, .nc-auto, .nc-more, .nc-clear,
      .nc-field select, .nc-field input, .nc-brow, .nc-type, .nc-person { min-height: 44px; }
      .nc-refresh { width: 44px; }
    }

    /* Zones sûres iOS — le shell (dashboard-layout) réserve DÉJÀ la bande du bas en mobile :
       calc(80px + env(safe-area-inset-bottom)), la place de la barre d'onglets. La redonner
       ici creuserait un vide sous la page. Reste le PAYSAGE, où le shell ne pose qu'un
       padding de 16px : sur iPhone couché, le notch mord le bord gauche et rogne les cartes. */
    @media (max-width: 900px) and (orientation: landscape) {
      .nc { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }
    }

    @media (prefers-reduced-motion: reduce) {
      .nc-health-dot, .nc-auto--on .nc-auto-dot, .nc-spin, .nc-skel { animation: none; }
    }
  `],
})
export class AdminNotificationsComponent implements OnInit, OnDestroy {
  private readonly api = inject(NotificationCenterApiService);

  protected readonly BackIcon = ChevronLeft;
  protected readonly BellIcon = BellRing;
  protected readonly RefreshIcon = RefreshCw;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly LoaderIcon = Loader;
  protected readonly ShieldIcon = ShieldCheck;
  protected readonly KeyIcon = KeyRound;
  protected readonly PhoneIcon = Smartphone;
  protected readonly ClockIcon = Clock;
  protected readonly UserXIcon = UserX;
  protected readonly UsersIcon = Users;
  protected readonly SendIcon = Send;
  protected readonly EyeOffIcon = EyeOff;
  protected readonly InboxIcon = Inbox;
  protected readonly FilterIcon = Filter;
  protected readonly SearchIcon = Search;

  // Helpers purs exposés au template (testés séparément, sans DOM).
  protected readonly relativeTime = relativeTime;
  protected readonly roleText = roleText;
  protected readonly alertTypeLabel = alertTypeLabel;
  protected readonly severityKey = severityKey;
  protected readonly severityLabel = severityLabel;
  protected readonly statusLabel = statusLabel;
  /** Ligne en cours de rejeu (une seule à la fois : l'action est délibérée, pas de masse). */
  protected readonly replayingId = signal<string | null>(null);
  /** Compte rendu par ligne, gardé à l'écran : « c'est parti » doit rester lisible. */
  protected readonly replayResult = signal<Record<string, string>>({});

  /**
   * Renvoie l'alerte de cette ligne à ses destinataires légitimes.
   *
   * ⚠️ Le compte rendu dit ce qui s'est VRAIMENT passé, y compris un échec. L'écran ne
   * doit jamais afficher « envoyé » quand le serveur a retenu l'envoi : c'est exactement
   * le genre de faux succès qui a laissé un client sans notification pendant des semaines
   * pendant que tout paraissait normal.
   */
  protected async onReplay(d: { id: string; alertId: string | null }): Promise<void> {
    if (!d.alertId || this.replayingId()) return;
    this.replayingId.set(d.id);
    try {
      const res = await firstValueFrom(this.api.replay(d.alertId));
      const partis = res.destinataires.filter((x) => x.sent > 0);
      const texte = partis.length
        ? `Envoyé à ${partis.map((x) => x.email).join(', ')}`
        : `Toujours retenu — ${res.destinataires.map((x) => x.reasonLabel ?? x.status).join(' · ') || 'aucun destinataire'}`;
      this.replayResult.update((m) => ({ ...m, [d.id]: texte }));
    } catch (err) {
      swallow('admin-notifications:onReplay', err);
      this.replayResult.update((m) => ({ ...m, [d.id]: 'Échec du renvoi — rien n’a été envoyé.' }));
    } finally {
      this.replayingId.set(null);
    }
  }

  protected readonly statusTone = statusTone;
  protected readonly reasonLabel = reasonLabel;
  protected readonly channelLabel = channelLabel;
  protected readonly rolloutLabel = rolloutLabel;
  protected readonly isRoleInScope = isRoleInScope;
  protected readonly withheldPct = withheldPct;
  protected readonly protectionNote = protectionNote;
  protected readonly deliveryDetail = deliveryDetail;
  protected readonly recipientName = recipientName;
  protected readonly gaugeDash = gaugeDash;

  protected readonly windows: { key: WindowKey; label: string; days: number }[] = [
    { key: '24h', label: '24 h', days: 1 },
    { key: '7d', label: '7 j', days: 7 },
    { key: '30d', label: '30 j', days: 30 },
  ];

  /** Ordre d'affichage du filtre d'issue : d'abord ce qui est parti, ensuite ce qui a été retenu. */
  protected readonly statuses: NotificationDeliveryStatus[] = ['SENT', 'SUPPRESSED', 'GROUPED', 'FAILED'];

  protected readonly windowKey = signal<WindowKey>('7d');
  protected readonly health = signal<NotificationHealthDto | null>(null);
  protected readonly summary = signal<NotificationSummaryDto | null>(null);
  protected readonly rows = signal<NotificationDeliveryRowDto[]>([]);
  protected readonly total = signal(0);
  protected readonly hasMore = signal(false);
  protected readonly loading = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly autoRefresh = signal(false);

  /**
   * Dernière notification RÉELLEMENT partie, chargée à part — indépendamment des filtres du
   * journal. Sinon l'aperçu du téléphone annoncerait « aucun push envoyé » dès qu'on filtre
   * sur les retenues, ce qui est exactement le contresens que cet écran doit éviter.
   */
  private readonly lastSent = signal<NotificationDeliveryRowDto[]>([]);

  /** Filtres du journal (appliqués côté serveur). */
  protected readonly fStatus = signal('');
  protected readonly fType = signal('');
  /** Famille selectionnee ('' = toutes). Le filtre le plus large de l'ecran. */
  protected readonly fCategory = signal('');
  /** Options du filtre : le contrat partage fait foi, pas une table locale. */
  protected readonly categoryOptions = NOTIFICATION_CATEGORIES.map((key) => ({
    key,
    label: NOTIFICATION_CATEGORY_LABELS[key],
  }));
  protected readonly fSeverity = signal('');
  protected readonly fReason = signal('');
  protected readonly fUserId = signal('');
  protected readonly fSearch = signal('');

  private page = 1;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private searchHandle: ReturnType<typeof setTimeout> | null = null;

  /**
   * Fenêtre de lecture GELÉE au dernier chargement complet.
   *
   * Elle était recalculée à chaque requête (`Date.now()` à chaque appel), ce qui rendait
   * l'écran incohérent avec lui-même : la synthèse et le journal ne portaient pas exactement
   * sur la même période, et surtout la borne haute AVANÇAIT entre deux pages. Comme le tri
   * est `createdAt desc`, une seule ligne insérée entre-temps décale tout d'un cran et la
   * page suivante renvoie une ligne déjà affichée — sur une table qui grossit de plusieurs
   * lignes par minute, c'est le cas courant, pas le cas limite.
   *
   * Un instantané figé règle les deux : la pagination est stable, et les chiffres de la
   * synthèse décrivent exactement les lignes qu'on est en train de lire.
   */
  private range: NotificationWindow = windowRange(7);

  protected readonly verdict = computed(() => healthVerdict(this.health()));
  protected readonly reasons = computed(() => reasonRows(this.summary()));
  protected readonly types = computed(() => typeRows(this.summary()));
  protected readonly preview = computed(() => previewFrom(this.lastSent()));

  /**
   * Options des menus déroulants : dérivées des DONNÉES de la période, jamais d'une liste
   * figée. Un menu qui propose 24 types dont 22 sans aucune ligne fait perdre du temps.
   * Le filtre actif est conservé même s'il disparaît des données, sinon le menu afficherait
   * « Tous » alors que le journal reste filtré.
   */
  protected readonly typeOptions = computed(() => {
    // Les étiquettes de synthèse (« Hors alerte ») sont écartées : proposées au menu, elles
    // renverraient toujours un journal vide.
    const rows = this.types().filter((t) => t.filterable);
    const current = this.fType();
    if (current && !rows.some((t) => t.key === current)) {
      return [...rows, { key: current, label: alertTypeLabel(current), count: 0, pct: 0, filterable: true }];
    }
    return rows;
  });

  protected readonly reasonOptions = computed(() => {
    const rows = this.reasons().filter((r) => r.filterable);
    const current = this.fReason();
    if (current && !rows.some((r) => r.key === current)) {
      return [...rows, { key: current, label: reasonLabel(current), count: 0, pct: 0, filterable: true }];
    }
    return rows;
  });

  /** Nombre de filtres actifs — sert au bouton « Effacer ». */
  protected readonly activeFilters = computed(() =>
    [this.fStatus(), this.fType(), this.fSeverity(), this.fReason(), this.fUserId(), this.fSearch()]
      .filter(Boolean).length,
  );

  ngOnInit(): void {
    void this.reload();
  }

  ngOnDestroy(): void {
    this.stopPoll();
    if (this.searchHandle) clearTimeout(this.searchHandle);
  }

  private currentDays(): number {
    return this.windows.find((w) => w.key === this.windowKey())?.days ?? 7;
  }

  private currentWindow(): NotificationWindow {
    return windowRange(this.currentDays());
  }

  protected windowLabel(): string {
    const k = this.windowKey();
    return k === '24h' ? '24 dernières heures' : k === '7d' ? '7 derniers jours' : '30 derniers jours';
  }

  protected setWindow(key: WindowKey): void {
    if (key === this.windowKey()) return;
    this.windowKey.set(key);
    void this.reload();
  }

  protected toggleAuto(on: boolean): void {
    this.autoRefresh.set(on);
    // Toujours repartir d'un timer propre : deux activations d'affilée (double événement,
    // restauration d'état) laisseraient sinon un intervalle orphelin qui continue de taper
    // sur l'API sans que rien ne puisse plus l'arrêter.
    this.stopPoll();
    if (on) {
      // 30 s : cet écran sert à surveiller, pas à regarder défiler. Plus court chargerait le
      // VPS (2 vCPU) pour rien — le volume utile est de quelques lignes par heure.
      this.pollHandle = setInterval(() => {
        if (this.loading() || this.loadingMore()) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        void this.refreshLight();
      }, 30_000);
    } else {
      this.stopPoll();
    }
  }

  private stopPoll(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /** Chargement complet des trois sections. */
  protected async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.fetchAll();
    } catch (e) {
      this.error.set(this.errMsg(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Rafraîchissement automatique : même contenu, sans spinner ni message bloquant. */
  private async refreshLight(): Promise<void> {
    try {
      if (this.page > 1) {
        // L'admin a déroulé plusieurs pages : on ne rafraîchit QUE la santé, qui ne dépend
        // d'aucune fenêtre et porte le signal de liveness. Recharger le reste le renverrait
        // à la page 1 toutes les 30 secondes, et décalerait l'instantané sous les pages
        // déjà chargées. Le bouton « Rafraîchir » reste là pour repartir de zéro.
        this.health.set(await firstValueFrom(this.api.health()));
        return;
      }
      await this.fetchAll();
    } catch (err) {
      // silencieux en auto : une coupure réseau passagère ne doit pas repeindre l'écran en rouge
      swallow('admin-notifications:refreshLight', err);
    }
  }

  private async fetchAll(): Promise<void> {
    // Un seul instantané pour les trois lectures : sans ça, la synthèse et le journal
    // portent sur des bornes différentes de quelques millisecondes et peuvent afficher deux
    // totaux qui ne se recoupent pas.
    this.range = this.currentWindow();
    const window = this.range;
    const [health, summary, lastSent] = await Promise.all([
      firstValueFrom(this.api.health()),
      firstValueFrom(this.api.summary(window)),
      firstValueFrom(this.api.deliveries({ ...window, status: 'SENT', page: 1, pageSize: 1 })),
    ]);
    this.health.set(health);
    this.summary.set(summary);
    this.lastSent.set(lastSent.rows);
    await this.loadPage(1);
  }

  /** Charge une page du journal. `page === 1` remplace, au-delà on ajoute à la suite. */
  private async loadPage(page: number): Promise<void> {
    const window = this.range;
    const res = await firstValueFrom(
      this.api.deliveries({
        ...window,
        status: this.fStatus() || undefined,
        category: this.fCategory() || undefined,
        alertType: this.fType() || undefined,
        severity: this.fSeverity() || undefined,
        reason: this.fReason() || undefined,
        userId: this.fUserId() || undefined,
        search: this.fSearch() || undefined,
        page,
        pageSize: NOTIFICATION_PAGE_SIZE,
      }),
    );
    this.page = page;
    this.rows.set(page <= 1 ? res.rows : mergePages(this.rows(), res.rows));
    this.total.set(res.total);
    this.hasMore.set(res.hasMore);
    // Une lecture réussie efface un message d'erreur devenu faux : sinon le bandeau rouge
    // d'une coupure passagère reste affiché au-dessus de données parfaitement à jour, et
    // l'admin ne sait plus s'il regarde une panne ou un vestige.
    this.error.set(null);
  }

  protected async loadMore(): Promise<void> {
    if (this.loadingMore() || !this.hasMore()) return;
    this.loadingMore.set(true);
    try {
      await this.loadPage(this.page + 1);
    } catch (e) {
      this.error.set(this.errMsg(e));
    } finally {
      this.loadingMore.set(false);
    }
  }

  /** Rechargement du journal seul (changement de filtre) — la synthèse ne bouge pas. */
  private reloadLog(): void {
    void this.loadPage(1).catch((e) => this.error.set(this.errMsg(e)));
  }

  protected setStatus(v: string): void {
    this.fStatus.set(v || '');
    this.reloadLog();
  }
  /** Depuis le menu OU depuis un clic sur une barre (re-cliquer désélectionne). */
  protected setType(v: string): void {
    this.fType.set(this.fType() === v ? '' : (v || ''));
    this.reloadLog();
  }
  protected setCategory(v: string): void {
    const next = v || '';
    this.fCategory.set(next);
    // Changer de famille rend le type d'alerte sélectionné incohérent : « Entretien »
    // + « Excès de vitesse » ne peut donner que zéro ligne, et l'écran se lirait alors
    // comme « il ne s'est rien passé » au lieu de « ces deux filtres s'excluent ».
    if (next && next !== 'ALERT') this.fType.set('');
    this.reloadLog();
  }
  protected setSeverity(v: string): void {
    this.fSeverity.set(v || '');
    this.reloadLog();
  }
  protected setReason(v: string): void {
    this.fReason.set(this.fReason() === v ? '' : (v || ''));
    this.reloadLog();
  }
  protected setUser(v: string): void {
    this.fUserId.set(this.fUserId() === v ? '' : (v || ''));
    this.reloadLog();
  }

  /**
   * Recherche libre, débouncée : une requête par frappe sur une table qui est la plus
   * volumineuse du produit après les positions serait une mauvaise idée sur un VPS à 2 vCPU.
   */
  protected setSearch(v: string): void {
    this.fSearch.set(v ?? '');
    if (this.searchHandle) clearTimeout(this.searchHandle);
    this.searchHandle = setTimeout(() => this.reloadLog(), 350);
  }

  protected clearFilters(): void {
    this.fStatus.set('');
    this.fType.set('');
    this.fSeverity.set('');
    this.fReason.set('');
    this.fUserId.set('');
    this.fSearch.set('');
    this.reloadLog();
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string } | null)?.message;
      if (m) return Array.isArray(m) ? m.join(', ') : m;
      return `Erreur (${e.status}).`;
    }
    return 'Une erreur est survenue.';
  }
}
