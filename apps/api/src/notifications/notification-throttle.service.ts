import { Injectable, Logger } from '@nestjs/common';
import type { AlertType } from '@vizyo/tracky-shared';
import { PUSH_COOLDOWN_MS, PUSH_MAX_PER_HOUR, bypassesRateLimit } from '@vizyo/tracky-shared';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * GARDE-FOUS ANTI-SPAM du PUSH — cooldown par (utilisateur, type, véhicule) et plafond
 * horaire par utilisateur.
 *
 * ── Pourquoi ce service existe ────────────────────────────────────────────────────────
 * Le push vient d'être réparé. Mesuré en production le 2026-07-27 sur 30 jours, voici ce
 * qu'il va effectivement pousser si on le laisse sans bride :
 *
 *   POWER_CUT    CRITICAL   9 903 → 330 / JOUR
 *   OVERSPEED    WARNING    4 933 → 164 / JOUR
 *   GEOFENCE_*   WARNING       54 →   2 / jour
 *   GPS_LOST     WARNING       14 → 0,5 / jour
 *   LOW_BATTERY  WARNING        4 → 4 PAR AN
 *   SOS          CRITICAL       3 → 3 PAR AN
 *
 * Les préférences (type coupé, seuil de sévérité) filtrent le bruit CONNU. Ce service
 * s'occupe du reste : le débit. C'est le rempart qui tient même quand un utilisateur
 * rallume tout, même quand un type d'alerte inconnu se met à tomber en boucle (boîtier
 * défectueux, zone morte GPS, trame Coban mal interprétée) — trois scénarios déjà vus.
 *
 * ── Pourquoi la BASE et pas une Map en mémoire ────────────────────────────────────────
 * Un compteur en mémoire se remet à zéro à chaque redémarrage de l'API (déploiement,
 * crash, OOM) — exactement les moments où une rafale d'alertes est probable — et il ne
 * voit rien de ce qu'une autre instance a envoyé. `notification_deliveries` est la source
 * de vérité PARTAGÉE : ce qui a fait vibrer un téléphone y est écrit, donc le garde-fou
 * survit au redémarrage et resterait juste le jour où l'API tournera en deux instances.
 *
 * ── Coût ──────────────────────────────────────────────────────────────────────────────
 * Le dispatch tourne sur CHAQUE alerte (~500/jour). Le contrôle coûte donc au plus :
 *   1. UNE lecture groupée de `notification_deliveries` pour TOUS les destinataires ;
 *   2. UNE lecture d'`alerts` PAR CLÉ PRIMAIRE, uniquement s'il y a des lignes à qualifier.
 * Jamais une requête par destinataire — c'est le piège évident quand on écrit ce genre de
 * filtre, et il se paierait 500 fois par jour multiplié par le nombre d'admins.
 *
 * La 2e requête est nécessaire parce que `notification_deliveries` ne porte PAS de
 * colonne `vehicleId` : le seul lien vers le véhicule est `alertId`. On ne la fait que sur
 * les identifiants déjà retenus par la 1re requête (fenêtre de 15 min), donc sur une
 * poignée de lignes, en accès par clé primaire.
 */

/** Fenêtre du plafond : une heure glissante. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Borne dure sur la lecture. En régime normal on est très en dessous : le plafond horaire
 * lui-même garantit ≤ 12 lignes SENT par utilisateur et par heure. Cette borne ne protège
 * donc que d'un cas dégénéré (bug de journalisation, réinjection massive d'historique).
 *
 * ⚠️ Si elle mordait, on lirait les lignes les PLUS RÉCENTES (tri décroissant) et on
 * sous-compterait le plafond — donc on laisserait passer un push de trop. C'est le sens
 * d'erreur choisi : un garde-fou ne doit jamais devenir une nouvelle cause de silence.
 */
const MAX_ROWS_SCANNED = 500;

/** Canal journalisé/inspecté. Seul le PUSH est bridé : EMAIL/WHATSAPP/SMS ne changent pas. */
export const PUSH_CHANNEL = 'WEB_PUSH';

/**
 * Statuts de `notification_deliveries` — source unique pour le throttle et le dispatch.
 *
 *   SENT       au moins un appareil a accepté (le téléphone a vibré) ;
 *   FAILED     des appareils étaient ciblés, tous ont échoué ;
 *   SUPPRESSED volontairement non envoyée (préférence, seuil, plafond, aucun appareil) ;
 *   GROUPED    repliée dans un envoi précédent (cooldown), avec son rang.
 */
export const DELIVERY_STATUS = {
  SENT: 'SENT',
  FAILED: 'FAILED',
  SUPPRESSED: 'SUPPRESSED',
  GROUPED: 'GROUPED',
} as const;

export type DeliveryStatus = (typeof DELIVERY_STATUS)[keyof typeof DELIVERY_STATUS];

/** Motifs de rétention décidés par CE service (sous-ensemble de `SuppressionReason`). */
export type ThrottleBlockReason = 'cooldown' | 'hourly_cap';

export interface ThrottleDecision {
  /** Faux = ne pas envoyer. Le dispatch doit alors journaliser la rétention. */
  allowed: boolean;
  /** Renseigné uniquement quand `allowed` est faux. */
  reason: ThrottleBlockReason | null;
  /**
   * Évènements DÉJÀ retenus pour ce (utilisateur, type, véhicule) depuis le dernier envoi.
   *
   * - décision passante : c'est le nombre d'évènements que ce push va solder → titre « ×N+1 » ;
   * - décision retenue  : c'est le nombre d'évènements déjà repliés AVANT celui-ci, donc
   *   le rang de l'évènement courant vaut `groupedCount + 1`.
   */
  groupedCount: number;
}

export interface ThrottleTarget {
  /** Type de l'alerte, forme Prisma (MAJUSCULES) telle qu'écrite dans les lignes de journal. */
  alertType: string;
  /** Véhicule concerné. `null` pour une alerte de flotte : le cooldown se réduit à (user, type). */
  vehicleId: string | null;
  /**
   * Escalade : ignore le cooldown (jamais le plafond).
   *
   * Une escalade est réclamée atomiquement UNE seule fois par alerte
   * (`Alert.escalatedAt`) et ne se déclenche que si PERSONNE n'a acquitté une alerte
   * CRITICAL. La replier dans un « ×N » silencieux reviendrait à supprimer précisément le
   * signal qui existe parce que le premier a été ignoré. Le plafond horaire, lui, reste
   * armé : c'est ce qui borne le scénario « 330 POWER_CUT non acquittées par jour ».
   */
  bypassCooldown?: boolean;
}

/** Décision passante — objet partagé, jamais muté par les appelants. */
const PASS: ThrottleDecision = Object.freeze({ allowed: true, reason: null, groupedCount: 0 });

interface DeliveryRow {
  userId: string;
  status: string;
  alertId: string | null;
  alertType: string | null;
  createdAt: Date;
}

@Injectable()
export class NotificationThrottleService {
  private readonly logger = new Logger(NotificationThrottleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /**
   * Décide, pour un lot de destinataires et une alerte, qui peut recevoir un push.
   *
   * Renvoie une décision par utilisateur. Un utilisateur absent de la réponse (cas
   * impossible en pratique) doit être traité comme passant par l'appelant : en cas de
   * doute, on notifie.
   */
  async evaluate(userIds: string[], target: ThrottleTarget): Promise<Map<string, ThrottleDecision>> {
    const decisions = new Map<string, ThrottleDecision>();
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return decisions;

    const now = Date.now();
    const hourSince = new Date(now - ONE_HOUR_MS);
    const cooldownSince = new Date(now - PUSH_COOLDOWN_MS);

    let rows: DeliveryRow[];
    try {
      // UNE requête pour les deux garde-fous à la fois :
      //   - toutes les lignes SENT de l'heure (plafond, TOUS types confondus) ;
      //   - les lignes GROUPED du MÊME type dans la fenêtre de cooldown (le report « ×N »).
      // Les FAILED et SUPPRESSED sont volontairement exclues : un push qui n'est pas parti
      // n'a fait vibrer aucun téléphone, il ne doit donc ni consommer le plafond ni ouvrir
      // un cooldown. Sinon un appareil désabonné suffirait à rendre un utilisateur muet.
      rows = await this.prisma.notificationDelivery.findMany({
        where: {
          userId: { in: ids },
          channel: PUSH_CHANNEL,
          createdAt: { gte: hourSince },
          OR: [
            { status: DELIVERY_STATUS.SENT },
            {
              status: DELIVERY_STATUS.GROUPED,
              alertType: target.alertType,
              createdAt: { gte: cooldownSince },
            },
          ],
        },
        select: { userId: true, status: true, alertId: true, alertType: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: MAX_ROWS_SCANNED,
      });
    } catch (err) {
      // FAIL-OPEN ASSUMÉ. Le bug qu'on répare était un silence invisible ; un garde-fou en
      // panne qui bloquerait tout en recréerait un, en pire (il serait dû à notre propre
      // code anti-spam). On laisse passer, on trace bruyamment.
      this.logger.warn(
        `[push] throttle indisponible, aucun bridage applique : ${err instanceof Error ? err.message : err}`,
      );
      this.errorLogger.recordBackground(
        err instanceof Error ? err : new Error(String(err)),
        'notifications',
        { stage: 'push-throttle', alertType: target.alertType },
      );
      for (const id of ids) decisions.set(id, PASS);
      return decisions;
    }

    const sameScopeAlertIds = await this.resolveSameScopeAlerts(rows, target);

    interface UserAccumulator {
      /** Push réellement partis dans l'heure, TOUS types confondus (plafond). */
      sentInHour: number;
      /**
       * Horodatage du dernier push PARTI pour ce (type, véhicule). Sert deux fois :
       * il ouvre le cooldown, et il marque la ligne de partage entre les événements
       * déjà soldés par son « ×N » et ceux encore en attente.
       */
      lastScopeSentAt: number | null;
      /** Horodatages des événements repliés pour ce (type, véhicule). */
      groupedAt: number[];
    }
    const perUser = new Map<string, UserAccumulator>();
    for (const id of ids) perUser.set(id, { sentInHour: 0, lastScopeSentAt: null, groupedAt: [] });

    for (const row of rows) {
      const acc = perUser.get(row.userId);
      if (!acc) continue;
      // « Même problème, même véhicule » : une ligne sans `alertId` (push de test, notif
      // hors alerte) ne peut être rattachée à aucun véhicule — elle compte pour le plafond
      // (le téléphone a vibré) mais n'ouvre aucun cooldown.
      const sameScope = !!row.alertId && sameScopeAlertIds.has(row.alertId);
      const at = row.createdAt.getTime();

      if (row.status === DELIVERY_STATUS.SENT) {
        acc.sentInHour++;
        // On garde le PLUS RÉCENT : l'ordre de lecture ne doit pas décider du résultat.
        if (sameScope && (acc.lastScopeSentAt === null || at > acc.lastScopeSentAt)) {
          acc.lastScopeSentAt = at;
        }
        continue;
      }
      // La requête a déjà borné les GROUPED au bon type ET à la fenêtre de cooldown.
      if (row.status === DELIVERY_STATUS.GROUPED && sameScope) acc.groupedAt.push(at);
    }

    // ⚠️ Le plafond ne doit JAMAIS retenir SOS/ACCIDENT/COLLISION/TOW/TAMPER/
    // ILLEGAL_IGNITION : quelques unités par AN, et vitales. Mieux vaut une notification
    // de trop qu'un SOS avalé par un compteur.
    //
    // Le COOLDOWN, lui, s'applique même à eux — volontairement. Un bouton SOS bloqué ou un
    // capteur d'arrachement en défaut est un mode de panne matériel réel : sans cooldown,
    // et avec le plafond contourné, ce serait le seul chemin du produit capable de faire
    // vibrer un téléphone sans aucune borne. Avec le cooldown, ça reste au pire 4 push par
    // heure et par véhicule, chacun annonçant honnêtement « ×N ».
    const capBypassed = bypassesRateLimit(target.alertType as AlertType);

    let cooldownBlocked = 0;
    let capBlocked = 0;
    for (const [id, acc] of perUser) {
      const lastSentAt = acc.lastScopeSentAt;
      const cooldownHit = lastSentAt !== null && lastSentAt >= cooldownSince.getTime();

      // ⚠️ Seuls les replis POSTÉRIEURS au dernier push parti sont encore EN ATTENTE.
      // Ceux d'avant ont déjà été soldés par le « ×N » de ce push : les recompter faisait
      // repartir le rang à 15 au lieu de 1 juste après un envoi, et le centre de
      // notifications affichait « 15 événements repliés » pour un seul événement retenu.
      // Le libellé poussé, lui, restait juste (quand le cooldown expire, le dernier envoi
      // est par construction hors fenêtre, donc plus aucune ligne périmée n'est comptée) —
      // c'est ce qui rendait l'écart invisible sans lire le journal.
      const grouped = lastSentAt === null
        ? acc.groupedAt.length
        : acc.groupedAt.filter((at) => at > lastSentAt).length;

      if (!target.bypassCooldown && cooldownHit) {
        decisions.set(id, { allowed: false, reason: 'cooldown', groupedCount: grouped });
        cooldownBlocked++;
        continue;
      }
      if (!capBypassed && acc.sentInHour >= PUSH_MAX_PER_HOUR) {
        decisions.set(id, { allowed: false, reason: 'hourly_cap', groupedCount: grouped });
        capBlocked++;
        continue;
      }
      decisions.set(id, { allowed: true, reason: null, groupedCount: grouped });
    }

    if (cooldownBlocked > 0 || capBlocked > 0) {
      // Préfixe '[push]' commun avec WebPushService et le dispatch : un seul grep raconte
      // toute la chaîne, du choix des destinataires jusqu'au code HTTP du push service.
      this.logger.log(
        `[push] throttle type=${target.alertType} vehicule=${target.vehicleId?.slice(0, 8) ?? '-'} — ${cooldownBlocked} replie(s) (cooldown), ${capBlocked} retenu(s) (plafond ${PUSH_MAX_PER_HOUR}/h)`,
      );
    }

    return decisions;
  }

  /**
   * Parmi les alertes citées par les lignes de journal, celles qui portent sur le MÊME
   * véhicule que l'alerte courante.
   *
   * `notification_deliveries` ne stocke pas le véhicule (seulement `alertId`) : c'est ce
   * détour qui donne au cooldown sa 3e dimension. Sans lui, une coupure d'alimentation sur
   * le véhicule A rendrait muette la même coupure sur le véhicule B pendant 15 minutes —
   * un garde-fou qui masque de l'information au lieu de la doser.
   *
   * Requête par CLÉ PRIMAIRE sur une poignée d'identifiants : elle ne dépend ni du nombre
   * de destinataires, ni de l'historique du véhicule.
   */
  private async resolveSameScopeAlerts(rows: DeliveryRow[], target: ThrottleTarget): Promise<Set<string>> {
    const candidates = new Set<string>();
    for (const row of rows) {
      if (row.alertId && row.alertType === target.alertType) candidates.add(row.alertId);
    }
    if (candidates.size === 0) return new Set<string>();

    try {
      const alerts = await this.prisma.alert.findMany({
        // `vehicleId: null` est traduit en « IS NULL » par Prisma : une alerte de flotte ne
        // partage donc son cooldown qu'avec d'autres alertes de flotte du même type.
        where: { id: { in: [...candidates] }, vehicleId: target.vehicleId },
        select: { id: true },
      });
      return new Set(alerts.map((a) => a.id));
    } catch (err) {
      // Même sens d'erreur que plus haut : on préfère un push de trop à un silence.
      this.logger.warn(
        `[push] throttle : qualification vehicule impossible, cooldown neutralise (${err instanceof Error ? err.message : err})`,
      );
      return new Set<string>();
    }
  }
}
