import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AlertSeverity as PrismaAlertSeverity,
  AlertType as PrismaAlertType,
  UserRole,
} from '@prisma/client';
import type { AlertSeverity, AlertType, NotificationCategory, NotificationPreferenceDto, UpdateNotificationPreferenceDto } from '@vizyo/tracky-shared';
import {
  DEFAULT_MIN_SEVERITY,
  DEFAULT_MUTED_TYPES,
  SEVERITY_ORDER,
  shouldPushAlert,
  defaultReceivesFleetAlerts,
  resolveReceivesFleetAlerts,
  DEFAULT_MUTED_CATEGORIES,
  isNotificationCategory,
} from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Préférences de notification PUSH — lecture, écriture, et AIGUILLAGE des destinataires.
 *
 * Contexte réel (constaté en production) : 582 alertes en 7 jours, ZÉRO push envoyé.
 * L'infrastructure fonctionnait pourtant (VAPID configuré, 14 abonnements en base) —
 * c'est l'aiguillage qui ne routait rien. Ce service est la pièce manquante : il dit
 * QUI reçoit un push, et selon QUELLES préférences.
 *
 * Trois principes qui expliquent chaque décision ci-dessous :
 *
 *   1. L'absence de réglage n'est JAMAIS le silence — mais ce n'est pas non plus « tout ».
 *      Un utilisateur qui n'a jamais ouvert l'écran des préférences doit recevoir les
 *      alertes utiles ET ne pas recevoir les deux sources de bruit mesurées (POWER_CUT et
 *      OVERSPEED, 494 notifications par jour à elles deux). Le défaut est donc CALIBRÉ sur
 *      des chiffres, pas choisi au jugé : voir `DEFAULT_PUSH_PREFERENCE` et son calcul.
 *
 *   2. Le défaut du périmètre est RESTREINT (`PUSH_ROLLOUT=SUPER_ADMIN_ONLY`). Une variable
 *      d'environnement absente ou mal orthographiée ne doit jamais AJOUTER de destinataires :
 *      seule la chaîne exacte 'ALL' élargit. Le pire cas acceptable est le silence (visible,
 *      corrigible) — pas l'envoi massif à des clients qui ne s'y attendent pas.
 *
 *   3. Ces préférences ne concernent QUE le push. EMAIL / WHATSAPP / SMS fonctionnent
 *      aujourd'hui et coûtent de l'argent : on ne touche pas à leur routage.
 */

/**
 * Types d'alerte acceptés en entrée, lus depuis l'enum Prisma plutôt que recopiés à la main.
 *
 * Pourquoi : une liste recopiée diverge au premier type ajouté au schéma, et l'écart est
 * silencieux (l'utilisateur coupe un type, la valeur est refusée ou pire, acceptée sans
 * jamais correspondre à rien). En la dérivant de l'enum, elle ne peut pas mentir.
 */
const KNOWN_ALERT_TYPES = new Set<string>(Object.values(PrismaAlertType));

/** Sévérités acceptées en entrée, dans la forme du contrat partagé (minuscules). */
const KNOWN_SEVERITIES = new Set<string>(SEVERITY_ORDER);

/**
 * ⚠️ FRONTIÈRE DE TYPES — le piège de ce lot.
 *
 * La base stocke l'enum Prisma en MAJUSCULES (INFO | WARNING | CRITICAL) ; le contrat
 * partagé avec la PWA est en MINUSCULES ('info' | 'warning' | 'critical'). L'écart est
 * historique et assumé : les payloads temps réel, les alertes déjà persistées et l'UI
 * dépendent tous de la forme minuscule. Harmoniser un seul des deux côtés casserait
 * l'autre en silence.
 *
 * Toute conversion passe donc par ces deux fonctions — et par elles seules, pour qu'il
 * n'existe qu'UN endroit à relire le jour où ça déraille.
 */
export function toSharedSeverity(severity: PrismaAlertSeverity): AlertSeverity {
  switch (severity) {
    case PrismaAlertSeverity.INFO:
      return 'info';
    case PrismaAlertSeverity.WARNING:
      return 'warning';
    case PrismaAlertSeverity.CRITICAL:
      return 'critical';
    default:
      // Enum élargi côté base sans passer ici : on retombe sur le défaut PRUDENT
      // (`critical`), donc « moins de push », jamais « plus de push ».
      return DEFAULT_MIN_SEVERITY;
  }
}

/** Réciproque de {@link toSharedSeverity} — utilisée avant toute écriture en base. */
export function toPrismaSeverity(severity: AlertSeverity): PrismaAlertSeverity {
  switch (severity) {
    case 'info':
      return PrismaAlertSeverity.INFO;
    case 'warning':
      return PrismaAlertSeverity.WARNING;
    case 'critical':
      return PrismaAlertSeverity.CRITICAL;
    default:
      return PrismaAlertSeverity.CRITICAL;
  }
}

/**
 * Normalise une sévérité venant d'un appelant qui peut détenir l'une OU l'autre forme.
 *
 * Le dispatch manipule des alertes Prisma (MAJUSCULES) tandis que le filtre partagé
 * raisonne en minuscules. Plutôt que d'imposer la conversion à chaque appelant — et de
 * découvrir l'oubli en production, sous la forme d'un push qui ne part pas — on accepte
 * les deux et on normalise ici.
 *
 * ⚠️ Le repli sur une valeur inconnue est `critical`, c'est-à-dire le HAUT de l'échelle,
 * et sa lecture dépend de ce qu'on normalise — d'où cette note, parce que la lecture
 * naïve est fausse dans un des deux cas :
 *   - sur la sévérité d'une ALERTE (l'usage ici), `critical` fait PASSER tous les seuils :
 *     une alerte dont la sévérité n'est pas reconnue est notifiée plutôt qu'avalée en
 *     silence. Une notification de trop se voit et se corrige ; une alerte grave perdue
 *     par un enum élargi ne se voit jamais.
 *   - sur un SEUIL de préférence (cf. `toSharedSeverity`), le même `critical` est au
 *     contraire le réglage le plus strict, donc « moins de push ».
 * Dans les deux cas le repli est prudent, mais pas pour la même raison.
 */
export function normalizeSeverity(severity: AlertSeverity | PrismaAlertSeverity | string): AlertSeverity {
  const lower = String(severity).toLowerCase();
  return KNOWN_SEVERITIES.has(lower) ? (lower as AlertSeverity) : DEFAULT_MIN_SEVERITY;
}

/**
 * Le rôle est-il concerné par le déploiement du push, en l'état actuel de l'environnement ?
 *
 * ⚠️ Test volontairement asymétrique : SEULE la chaîne exacte 'ALL' élargit le périmètre.
 * Une valeur absente, vide, mal orthographiée ('all', 'TOUS', 'SUPER_ADMIN') retombe sur
 * le périmètre restreint. C'est la garantie qu'une erreur de configuration ne peut pas
 * arroser les clients par accident.
 */
export function isPushRoleEligible(role: UserRole | string, rollout: string | undefined): boolean {
  if (rollout === 'ALL') return true;
  return role === UserRole.SUPER_ADMIN;
}

/**
 * ════════════════════════════════════════════════════════════════════════════════
 * PRÉFÉRENCE PAR DÉFAUT — appliquée tant que l'utilisateur n'a JAMAIS rien enregistré.
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Le couple (seuil, types coupés) n'est pas une préférence de goût : il est CALCULÉ sur
 * les volumes réels mesurés en production le 2026-07-27, sur 30 jours glissants.
 *
 *   POWER_CUT    CRITICAL   9 903  →  330   / jour
 *   OVERSPEED    WARNING    4 933  →  164   / jour
 *   GEOFENCE_*   WARNING       54  →    1,8 / jour
 *   GPS_LOST     WARNING       14  →    0,5 / jour
 *   LOW_BATTERY  WARNING        4  →  ~4    par AN
 *   SOS          CRITICAL       3  →  ~3    par AN
 *
 * ─── Le calcul du défaut retenu : seuil `warning` + coupure de POWER_CUT et OVERSPEED ───
 *
 *   POWER_CUT    330   /j  →  0      (coupé PAR TYPE)
 *   OVERSPEED    164   /j  →  0      (coupé PAR TYPE)
 *   GEOFENCE_*     1,8 /j  →  1,8    (WARNING, passe le seuil)
 *   GPS_LOST       0,5 /j  →  0,5    (WARNING, passe le seuil)
 *   LOW_BATTERY    4/an    →  0,01   (WARNING, passe le seuil)
 *   SOS            3/an    →  0,01   (CRITICAL, passe le seuil)
 *   freinage / accélération / virage brusque, vibration, arrêt prolongé (INFO)
 *                          →  0      (retenus par le seuil)
 *   ────────────────────────────────────────────────────────────────────────────
 *   TOTAL                  ≈  2,3 notifications par jour, pour tout le parc.
 *
 * Soit deux ou trois vibrations par jour : on peut vivre avec, donc on ne coupe pas tout
 * au bout d'une semaine.
 *
 * ─── Pourquoi PAS les trois autres couples envisagés ───
 *
 * 1. `critical` + rien coupé (L'ANCIEN DÉFAUT) = 330 notifications / jour. POWER_CUT est
 *    classé CRITICAL : le réglage qui a l'air le plus prudent est en réalité le PIRE.
 *    C'est l'enseignement central de la mesure — la sévérité seule ne protège de rien.
 *
 * 2. `critical` + POWER_CUT/OVERSPEED coupés ≈ 0 notification / jour… mais LOW_BATTERY est
 *    une WARNING : elle ne passerait JAMAIS. Or c'est précisément ce que l'utilisateur veut
 *    pouvoir vérifier. Il testerait « batterie faible », ne recevrait rien, et conclurait
 *    que le push est encore cassé. On remplacerait un silence par un autre silence.
 *
 * 3. `warning` + rien coupé = 496 / jour. Le seuil abaissé SANS coupure par type est le
 *    piège inverse : l'utilisateur qui élargit se fait ensevelir.
 *
 * 4. `info` + POWER_CUT/OVERSPEED coupés : ouvrirait les alertes de conduite (freinage,
 *    accélération, virage). Aucune n'a été comptée sur 30 jours, donc leur volume est
 *    INCONNU — et un volume inconnu n'a rien à faire dans un défaut.
 *
 * ⚠️ Ce défaut ne s'applique QU'À L'ABSENCE DE LIGNE. Un utilisateur qui possède une ligne
 * avec `mutedTypes: []` a explicitement TOUT rallumé : lui superposer ces coupures
 * reviendrait à défaire son choix en silence, exactement le comportement qu'on répare.
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ INVARIANT INTER-SERVICES — à vérifier avant toute modification de ce bloc.
 *
 * Ce défaut décide de ce que l'ÉCRAN affiche et annonce (`GET /notifications/preferences`
 * remonte ces valeurs avec `isDefault=true`, et la PWA en déduit « voici ce que vous
 * recevrez »). Ce n'est PAS lui qui décide de l'envoi : la porte réelle est
 * `NotificationDispatchService#checkPushPreference`, qui applique son propre défaut pour
 * un utilisateur sans ligne.
 *
 * Les deux DOIVENT donc rester identiques, et la seule façon sûre est que le dispatch
 * consomme `defaultPushPreference()` exporté ici plutôt que d'en garder une copie. Sinon
 * l'écart ne casse aucun test — il produit simplement un écran qui promet une livraison
 * que le serveur refuse, c'est-à-dire le bug d'origine remis dans l'autre sens.
 * ══════════════════════════════════════════════════════════════════════════════════
 */
export const DEFAULT_PUSH_PREFERENCE = {
  pushEnabled: true,
  /**
   * ⚠️ Volontairement `warning`, et non `DEFAULT_MIN_SEVERITY` (= `critical`) du contrat
   * partagé. Les deux constantes répondent à des questions différentes :
   *   - `DEFAULT_MIN_SEVERITY` est un REPLI PRUDENT de conversion, pour une valeur d'enum
   *     inconnue (cf. `toSharedSeverity`) : là, `critical` veut dire « le moins de push ».
   *   - ici c'est un CHOIX PRODUIT calibré sur les volumes ci-dessus : `critical` seul
   *     laisserait passer POWER_CUT (330/j) et bloquerait LOW_BATTERY (4/an).
   * Les aligner « pour faire propre » casserait l'un des deux.
   */
  minSeverity: 'warning' as AlertSeverity,
  mutedTypes: DEFAULT_MUTED_TYPES,
  /** Aucune catégorie coupée par défaut : le bruit vient de TYPES précis, pas de familles. */
  mutedCategories: DEFAULT_MUTED_CATEGORIES,
} as const;

/**
 * Copie FRAÎCHE et mutable du défaut.
 *
 * `DEFAULT_MUTED_TYPES` est un tableau partagé par tout le processus : le renvoyer tel quel
 * dans un DTO exposerait la constante à une mutation accidentelle d'un appelant (un `.push()`
 * quelque part et tous les utilisateurs sans réglage héritent d'une coupure de plus).
 */
export function defaultPushPreference(): {
  pushEnabled: boolean;
  minSeverity: AlertSeverity;
  mutedTypes: AlertType[];
  mutedCategories: NotificationCategory[];
} {
  return {
    pushEnabled: DEFAULT_PUSH_PREFERENCE.pushEnabled,
    minSeverity: DEFAULT_PUSH_PREFERENCE.minSeverity,
    mutedTypes: [...DEFAULT_PUSH_PREFERENCE.mutedTypes],
    mutedCategories: [...DEFAULT_PUSH_PREFERENCE.mutedCategories],
  };
}

/** Forme minimale d'un destinataire candidat, telle que le dispatch la possède déjà. */
export interface PushCandidate {
  id: string;
  role: UserRole | string;
}

@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Valeur courante de PUSH_ROLLOUT (lue à chaque appel : un redémarrage suffit à basculer). */
  private rollout(): string {
    return this.config.get('PUSH_ROLLOUT', { infer: true }) ?? 'SUPER_ADMIN_ONLY';
  }

  /**
   * Préférences de l'utilisateur courant, prêtes à afficher.
   *
   * Renvoie TOUJOURS une préférence exploitable : sans ligne en base, le défaut calibré
   * (cf. `DEFAULT_PUSH_PREFERENCE` — seuil `warning`, POWER_CUT et OVERSPEED coupés) est
   * retourné TEL QUEL avec `isDefault=true`, pour que l'écran puisse expliquer « voici ce
   * qui s'applique » au lieu de présenter un choix jamais fait.
   *
   * Le DTO expose donc de vraies coupures que l'utilisateur n'a pas posées lui-même. C'est
   * assumé, et c'est la raison pour laquelle `isDefault` reste vrai : l'écran s'en sert pour
   * dire QUI a coupé quoi, et affiche à côté de chaque type coupé par défaut la fréquence
   * mesurée qui l'a motivé. Un défaut expliqué se rallume en un geste ; un défaut caché est
   * exactement le silence qu'on vient de réparer.
   */
  async get(userId: string, role: UserRole | string): Promise<NotificationPreferenceDto> {
    const [row, deviceCount] = await Promise.all([
      this.prisma.notificationPreference.findUnique({ where: { userId } }),
      this.prisma.pushSubscription.count({ where: { userId } }),
    ]);

    const eligible = isPushRoleEligible(role, this.rollout());

    if (!row) {
      return {
        ...defaultPushPreference(),
        isDefault: true,
        eligible,
        deviceCount,
        // Aucune ligne : le rôle décide, exactement comme avant l'ouverture du réglage.
        receivesFleetAlerts: defaultReceivesFleetAlerts(String(role)),
        receivesFleetAlertsIsDefault: true,
      };
    }

    return {
      pushEnabled: row.pushEnabled,
      // Valeur RÉSOLUE : le choix explicite s'il existe, sinon le défaut du rôle.
      // `null` en base = « selon mon rôle », ce qui n'est PAS « non ».
      receivesFleetAlerts: resolveReceivesFleetAlerts(row.receivesFleetAlerts, String(role)),
      receivesFleetAlertsIsDefault: row.receivesFleetAlerts == null,
      // Colonne ajoutée après coup : une ligne écrite avant la migration a `[]`, ce qui
      // est le bon défaut (aucune catégorie coupée). On filtre les valeurs inconnues —
      // une catégorie retirée du code ne doit pas casser la lecture.
      mutedCategories: (row.mutedCategories ?? []).filter(isNotificationCategory),
      minSeverity: toSharedSeverity(row.minSeverity),
      // ⚠️ AUCUNE fusion avec le défaut ici, et c'est délibéré : une ligne existante dont
      // `mutedTypes` est vide signifie « j'ai TOUT rallumé, y compris les coupures par
      // défaut ». Ajouter POWER_CUT/OVERSPEED par-dessus annulerait ce choix sans le dire.
      //
      // `mutedTypes` est stocké en texte (et non en enum[]) pour qu'un type retiré du code
      // ne casse pas la lecture des lignes existantes — on filtre donc ici les valeurs
      // devenues inconnues plutôt que de les propager à l'UI.
      mutedTypes: row.mutedTypes.filter((t) => KNOWN_ALERT_TYPES.has(t)) as AlertType[],
      isDefault: false,
      eligible,
      deviceCount,
    };
  }

  /**
   * Enregistre une mise à jour PARTIELLE des préférences de l'utilisateur courant.
   *
   * `userId` vient exclusivement du jeton : aucun identifiant n'est accepté depuis le
   * corps de la requête, sinon l'endpoint deviendrait une porte pour lire ou modifier
   * les réglages d'autrui.
   */
  async update(
    userId: string,
    role: UserRole | string,
    patch: UpdateNotificationPreferenceDto,
  ): Promise<NotificationPreferenceDto> {
    const clean = this.validate(patch);

    // Corps sans aucun champ connu (client qui envoie `{}`, ou uniquement des clés
    // ignorées comme un `userId` glissé dans la requête) : on ne crée RIEN. Sinon un
    // appel vide matérialiserait une ligne aux valeurs par défaut, ce qui basculerait
    // `isDefault` à false et ferait dire à l'écran « voici votre choix » alors que
    // l'utilisateur n'a jamais rien choisi.
    if (Object.keys(clean).length === 0) {
      return this.get(userId, role);
    }

    // Upsert : première écriture = création de la ligne avec les défauts pour les champs
    // non fournis ; écritures suivantes = mise à jour des seuls champs fournis.
    //
    // ⚠️ À LA CRÉATION, `mutedTypes` non fourni vaut le DÉFAUT, jamais `[]`. Le scénario
    // qui l'impose : l'utilisateur sans ligne voit l'écran afficher « alimentation coupée »
    // et « excès de vitesse » coupés par défaut, puis il touche uniquement au seuil de
    // gravité. Le corps envoyé ne contient alors que `minSeverity`. Avec `[]`, la ligne
    // créée RALLUMERAIT POWER_CUT (330 notifications/jour) sans qu'il l'ait demandé — un
    // réglage qui produit l'inverse de ce que l'écran montrait juste avant. On matérialise
    // donc ce qui était affiché.
    const defaults = defaultPushPreference();
    await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        pushEnabled: clean.pushEnabled ?? defaults.pushEnabled,
        minSeverity: toPrismaSeverity(clean.minSeverity ?? defaults.minSeverity),
        mutedTypes: clean.mutedTypes ?? defaults.mutedTypes,
        // Non fourni à la création => on laisse `null`, c.-à-d. « selon mon rôle ».
        // Matérialiser un booléen ici figerait le comportement actuel et empêcherait
        // un changement de rôle de se répercuter.
        receivesFleetAlerts: clean.receivesFleetAlerts ?? null,
        mutedCategories: clean.mutedCategories ?? [...defaults.mutedCategories],
      },
      update: {
        ...(clean.pushEnabled !== undefined ? { pushEnabled: clean.pushEnabled } : {}),
        ...(clean.minSeverity !== undefined ? { minSeverity: toPrismaSeverity(clean.minSeverity) } : {}),
        ...(clean.mutedTypes !== undefined ? { mutedTypes: clean.mutedTypes } : {}),
        // `null` est une valeur voulue (« selon mon rôle »), pas une absence : on teste
        // `!== undefined` et non la véracité, sinon on ne pourrait jamais revenir au défaut.
        ...(clean.receivesFleetAlerts !== undefined ? { receivesFleetAlerts: clean.receivesFleetAlerts } : {}),
        ...(clean.mutedCategories !== undefined ? { mutedCategories: clean.mutedCategories } : {}),
      },
    });

    // Relecture : l'écran doit afficher l'état RÉEL en base (y compris `deviceCount` et
    // `eligible`), pas l'écho du formulaire qu'il vient d'envoyer.
    return this.get(userId, role);
  }

  /**
   * Parmi des destinataires déjà retenus par le dispatch, ceux qui doivent recevoir un PUSH.
   *
   * Point d'entrée unique de l'aiguillage push, pour que le filtre par préférence ne
   * s'applique qu'ici — donc au push seul, jamais à EMAIL / WHATSAPP / SMS.
   *
   * ⚠️ CE FILTRE NE CLOISONNE PAS LES FLOTTES. Il ne juge que du périmètre de
   * déploiement (rôle) et des préférences ; il fait confiance à l'appelant sur le
   * fait que `candidates` a DÉJÀ été restreint à la flotte de l'alerte. Le seul
   * destinataire cross-flotte légitime est le SUPER_ADMIN, et cette exception doit
   * rester explicite du côté qui résout les destinataires — pas s'introduire ici par
   * inadvertance le jour où quelqu'un passera « tous les utilisateurs » en entrée.
   *
   * Une SEULE requête pour l'ensemble des candidats : le dispatch traite parfois des
   * dizaines de destinataires par alerte, et une requête par personne se paierait sur
   * chacune des ~580 alertes hebdomadaires.
   */
  async filterPushRecipients(
    candidates: PushCandidate[],
    alert: { type: AlertType | string; severity: AlertSeverity | PrismaAlertSeverity | string },
  ): Promise<string[]> {
    if (candidates.length === 0) return [];

    const rollout = this.rollout();
    // Filtre de périmètre d'abord : inutile d'interroger la base pour des rôles qui ne
    // sont de toute façon pas concernés par la phase de déploiement en cours.
    const seen = new Set<string>();
    const eligibles: PushCandidate[] = [];
    for (const candidate of candidates) {
      if (!isPushRoleEligible(candidate.role, rollout)) continue;
      // Dédoublonnage : un même utilisateur peut arriver deux fois (destinataire de sa
      // flotte ET cible d'escalade d'une règle). Deux entrées = deux push identiques sur
      // le même téléphone — précisément le détail qui fait couper les notifications.
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      eligibles.push(candidate);
    }
    if (eligibles.length === 0) return [];

    const rows = await this.prisma.notificationPreference.findMany({
      where: { userId: { in: eligibles.map((c) => c.id) } },
    });
    const byUser = new Map(rows.map((r) => [r.userId, r]));

    const normalized = {
      type: (KNOWN_ALERT_TYPES.has(String(alert.type)) ? String(alert.type) : 'UNKNOWN') as AlertType,
      severity: normalizeSeverity(alert.severity),
    };

    return eligibles
      .filter((c) => {
        const row = byUser.get(c.id);
        // ⚠️ Le cœur du bug d'origine : SANS ligne de préférence, on applique le défaut
        // UTILE — pas le silence. Les quatre SUPER_ADMIN de production n'ont aucune ligne ;
        // s'ils étaient écartés ici, on aurait « réparé » le push sans qu'il parte jamais.
        //
        // Et « utile » ne veut pas dire « tout » : ce même défaut coupe POWER_CUT et
        // OVERSPEED, faute de quoi ces quatre comptes recevraient les 494 notifications
        // quotidiennes mesurées. La lecture est la même que dans `get()` — un utilisateur
        // AVEC une ligne garde ses choix intacts, défaut compris s'il l'a rallumé.
        const pref = row
          ? {
              pushEnabled: row.pushEnabled,
              minSeverity: toSharedSeverity(row.minSeverity),
              mutedTypes: row.mutedTypes.filter((t) => KNOWN_ALERT_TYPES.has(t)) as AlertType[],
            }
          : defaultPushPreference();
        // Décision déléguée au contrat partagé : l'API filtre et la PWA annonce
        // « vous recevrez ceci » avec exactement la même règle.
        return shouldPushAlert(pref, normalized);
      })
      .map((c) => c.id);
  }

  /**
   * Valide le corps reçu du client.
   *
   * Un client bugué (ou curieux) ne doit pas pouvoir écrire n'importe quoi en base : un
   * type d'alerte inventé dans `mutedTypes` se traduirait par une coupure qui ne coupe
   * rien, invisible à la relecture et impossible à diagnostiquer depuis l'écran.
   */
  private validate(patch: UpdateNotificationPreferenceDto): UpdateNotificationPreferenceDto {
    if (!patch || typeof patch !== 'object') {
      throw new BadRequestException('Corps de requête invalide');
    }
    const clean: UpdateNotificationPreferenceDto = {};

    if (patch.pushEnabled !== undefined) {
      if (typeof patch.pushEnabled !== 'boolean') {
        throw new BadRequestException('pushEnabled doit être un booléen');
      }
      clean.pushEnabled = patch.pushEnabled;
    }

    // `null` est une valeur LÉGITIME et distincte de `undefined` : elle remet le réglage
    // sur « selon mon rôle » au lieu de forcer oui/non. Sans ce cas, un utilisateur ne
    // pourrait jamais revenir au défaut une fois qu'il y a touché.
    if (patch.receivesFleetAlerts !== undefined) {
      if (patch.receivesFleetAlerts !== null && typeof patch.receivesFleetAlerts !== 'boolean') {
        throw new BadRequestException('receivesFleetAlerts doit être un booléen ou null');
      }
      clean.receivesFleetAlerts = patch.receivesFleetAlerts;
    }

    if (patch.minSeverity !== undefined) {
      if (typeof patch.minSeverity !== 'string' || !KNOWN_SEVERITIES.has(patch.minSeverity)) {
        throw new BadRequestException(
          `minSeverity invalide — attendu : ${SEVERITY_ORDER.join(', ')}`,
        );
      }
      clean.minSeverity = patch.minSeverity;
    }

    if (patch.mutedCategories !== undefined) {
      if (!Array.isArray(patch.mutedCategories)) {
        throw new BadRequestException('mutedCategories doit être un tableau');
      }
      const unknown = patch.mutedCategories.filter((c) => !isNotificationCategory(c));
      if (unknown.length > 0) {
        throw new BadRequestException(`Catégorie inconnue : ${unknown.join(', ')}`);
      }
      clean.mutedCategories = patch.mutedCategories;
    }

    if (patch.mutedTypes !== undefined) {
      if (!Array.isArray(patch.mutedTypes)) {
        throw new BadRequestException('mutedTypes doit être un tableau');
      }
      const seen = new Set<string>();
      for (const t of patch.mutedTypes) {
        if (typeof t !== 'string' || !KNOWN_ALERT_TYPES.has(t)) {
          throw new BadRequestException(`Type d'alerte inconnu : ${String(t)}`);
        }
        seen.add(t);
      }
      // Dédoublonnage : deux entrées identiques n'ont aucun sens et gonflent la ligne
      // à chaque enregistrement d'un écran qui rejouerait sa sélection.
      clean.mutedTypes = [...seen] as AlertType[];
    }

    return clean;
  }
}
