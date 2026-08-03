import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserRole } from '@prisma/client';
import type {
  AlertSeverity,
  NotificationCategory,
  NotificationChannel,
  NotificationCountDto,
  NotificationDeliveryPageDto,
  NotificationDeliveryQueryDto,
  NotificationDeliveryRowDto,
  NotificationHealthDto,
  NotificationRoleReachDto,
  NotificationSummaryDto,
  NotificationSuppressionReasonDto,
  NotificationTopRecipientDto,
  SuppressionReason,
} from '@vizyo/tracky-shared';
import {
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_DEFAULT_WINDOW_DAYS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_MAX_PAGE_SIZE,
  NOTIFICATION_MAX_WINDOW_DAYS,
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_SEVERITY_LABELS,
  NOTIFICATION_STATUS_LABELS,
  NOTIFICATION_TOP_RECIPIENTS,
  SEVERITY_ORDER,
  isNotificationCategory,
  SUPPRESSION_LABELS,
} from '@vizyo/tracky-shared';
import { OwnerVisibilityService } from '../common/owner-visibility.service';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { isPushRoleEligible } from './notification-preferences.service';
import { WebPushService } from './web-push.service';
import { NotificationDispatchService, type AlertWithVehicle } from './notification-dispatch.service';

/**
 * CENTRE DE NOTIFICATIONS — lecture d'administration (SUPER_ADMIN), STRICTEMENT en lecture.
 *
 * ── Pourquoi cet écran existe ────────────────────────────────────────────────────────
 * On vient de réparer un push qui ne partait jamais : 582 alertes en 7 jours, zéro
 * notification, et RIEN nulle part pour le dire. Le correctif seul ne suffit pas, parce
 * que la suite du problème est de la même famille : les garde-fous anti-spam retiennent
 * volontairement des notifications (préférence, seuil de sévérité, plafond horaire,
 * regroupement). Sans cet écran, un utilisateur qui ne reçoit rien serait exactement aussi
 * démuni qu'avant — il ne saurait pas distinguer « le système a décidé de se taire » de
 * « le système est cassé ».
 *
 * D'où la règle qui gouverne tout le fichier : **on lit les non-envois avec le même soin
 * que les envois.** `SUPPRESSED` et `GROUPED` ne sont pas du déchet à filtrer par défaut,
 * ce sont les lignes les plus instructives de la table.
 *
 * ── Les chiffres qui dictent les bornes ──────────────────────────────────────────────
 * Mesuré en production le 2026-07-27, sur 30 jours :
 *   POWER_CUT 9 903 (330/jour, CRITICAL) · OVERSPEED 4 933 (164/jour) · GEOFENCE 54
 *   GPS_LOST 14 · LOW_BATTERY 4 (par AN) · SOS 3 (par AN)
 *
 * Deux conséquences directes ici :
 *   1. La table des envois grossit d'environ 500 alertes/jour × N destinataires. AUCUNE
 *      lecture ne part sans fenêtre temporelle bornée ni pagination plafonnée — sinon le
 *      premier chargement de l'écran ramènerait des dizaines de milliers de lignes avec
 *      leur corps de message.
 *   2. Les alertes qui comptent (SOS, batterie : 3 et 4 par AN) sont invisibles dans un
 *      flux brut. C'est la synthèse par type et par motif qui les fait ressortir, pas la
 *      liste.
 *
 * ── Ce que ce service ne fait PAS ────────────────────────────────────────────────────
 * Aucune écriture, aucun rejeu, aucune purge. Un centre d'observation qui peut agir
 * devient un endroit où l'on casse la production en cliquant. Et il n'influence en rien
 * les canaux payants (EMAIL / WHATSAPP / SMS) : il les observe, il ne les pilote pas.
 */

/** Viewer minimal : seul le flag owner change ce qui est visible. */
type Viewer = { isOwner?: boolean | null };

/** Statuts considérés comme « retenue volontaire » (jamais parties, par décision). */
const WITHHELD_STATUSES = ['SUPPRESSED', 'GROUPED'] as const;

/**
 * Décalage maximal autorisé en pagination.
 *
 * Un `OFFSET 250000` sur une table de plusieurs millions de lignes fait scanner toutes les
 * lignes sautées à chaque page. On refuse explicitement, avec un message qui dit quoi faire
 * (affiner les filtres), plutôt que de servir une requête qui met la base à genoux.
 */
const MAX_OFFSET = 10_000;

/** Échantillon nominatif d'utilisateurs injoignables remonté par `/health`. */
const UNREACHABLE_SAMPLE = 25;

/** Types d'alerte remontés dans la synthèse (au-delà, la queue n'apprend plus rien). */
const TOP_ALERT_TYPES = 15;

@Injectable()
export class NotificationCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerVis: OwnerVisibilityService,
    private readonly config: ConfigService<Env, true>,
    private readonly webPush: WebPushService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  // ─── Journal des envois ────────────────────────────────────────────────────────────

  /**
   * Page du journal, filtrable. Chaque ligne se lit seule : qui, quoi, par quel canal,
   * avec quelle issue et — quand ce n'est pas parti — POURQUOI, en français.
   */
  async deliveries(
    query: NotificationDeliveryQueryDto,
    viewer: Viewer = {},
  ): Promise<NotificationDeliveryPageDto> {
    const window = this.resolveWindow(query.from, query.to);
    // `Number.isFinite` avant tout calcul, sur les DEUX entiers : un `page=NaN` (query string
    // exotique, appel direct du service) produirait un `skip` NaN qui passe le test de
    // profondeur sans broncher et part tel quel dans le OFFSET SQL. Et une taille de page
    // illisible doit retomber sur le DÉFAUT (50), pas sur le minimum : un `pageSize=abc` qui
    // renverrait silencieusement 1 seule ligne se lirait comme « il n'y a presque rien »,
    // c'est-à-dire exactement le contresens que cet écran existe pour empêcher.
    const pageSize = this.clamp(
      Number.isFinite(query.pageSize) ? (query.pageSize as number) : NOTIFICATION_PAGE_SIZE,
      1,
      NOTIFICATION_MAX_PAGE_SIZE,
    );
    const page = Number.isFinite(query.page) ? Math.max(1, Math.trunc(query.page as number)) : 1;
    const skip = (page - 1) * pageSize;
    if (skip > MAX_OFFSET) {
      throw new BadRequestException(
        `Pagination trop profonde (au-delà de ${MAX_OFFSET} lignes). Affinez la période ou les filtres.`,
      );
    }

    const where = await this.buildWhere(query, window, viewer);

    const [total, rows] = await Promise.all([
      this.prisma.notificationDelivery.count({ where }),
      this.prisma.notificationDelivery.findMany({
        where,
        // (createdAt desc, id desc) : l'ordre secondaire évite qu'une page rejoue une ligne
        // déjà vue quand plusieurs envois partagent la milliseconde — ce qui est la norme
        // ici, une alerte produisant N lignes d'un coup pour N destinataires.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
        include: {
          // L'identité est jointe plutôt que résolue après coup : un journal qui affiche
          // des UUID ne sert à personne, et une requête par ligne serait pire.
          user: { select: { email: true, firstName: true, lastName: true, role: true } },
        },
      }),
    ]);

    const fleetNames = await this.resolveFleetNames(rows.map((r) => r.fleetId));

    return {
      rows: rows.map((r) => this.toRow(r, fleetNames)),
      total,
      page,
      pageSize,
      hasMore: skip + rows.length < total,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    };
  }

  // ─── Synthèse ──────────────────────────────────────────────────────────────────────

  /**
   * Vue d'ensemble sur la période : totaux par statut / type / canal / sévérité, top
   * destinataires, et surtout le TAUX de retenue avec sa répartition par motif.
   *
   * C'est ce dernier chiffre qui rend le système lisible d'un coup d'œil : « 412
   * notifications · 38 envoyées · 374 retenues (dont 330 par préférence) » se comprend
   * immédiatement, là où 412 lignes brutes ne se comprennent pas du tout.
   */
  async summary(
    query: Pick<NotificationDeliveryQueryDto, 'from' | 'to' | 'channel' | 'fleetId' | 'userId'>,
    viewer: Viewer = {},
  ): Promise<NotificationSummaryDto> {
    const window = this.resolveWindow(query.from, query.to);
    const where = await this.buildWhere(query, window, viewer);

    const [byStatusRows, byChannelRows, bySeverityRows, byTypeRows,
      byCategoryRows, byReasonRows, byRecipientRows] =
      await Promise.all([
        this.prisma.notificationDelivery.groupBy({ by: ['status'], where, _count: { _all: true } }),
        this.prisma.notificationDelivery.groupBy({ by: ['channel'], where, _count: { _all: true } }),
        this.prisma.notificationDelivery.groupBy({ by: ['severity'], where, _count: { _all: true } }),
        this.prisma.notificationDelivery.groupBy({ by: ['alertType'], where, _count: { _all: true } }),
        this.prisma.notificationDelivery.groupBy({ by: ['category'], where, _count: { _all: true } }),
        this.prisma.notificationDelivery.groupBy({
          by: ['reason'],
          // Les motifs n'ont de sens que sur les retenues. On ANDe le filtre au lieu de
          // l'écraser : si l'appelant a déjà demandé un statut précis, sa demande gagne
          // (et la répartition sort vide, ce qui est la réponse honnête).
          where: this.and(where, { status: { in: [...WITHHELD_STATUSES] } }),
          _count: { _all: true },
        }),
        this.prisma.notificationDelivery.groupBy({
          by: ['userId', 'status'],
          where,
          _count: { _all: true },
        }),
      ]);

    const statusCount = (s: string): number =>
      byStatusRows.find((r) => r.status === s)?._count._all ?? 0;

    const sent = statusCount('SENT');
    const failed = statusCount('FAILED');
    const suppressed = statusCount('SUPPRESSED');
    const grouped = statusCount('GROUPED');
    const total = byStatusRows.reduce((acc, r) => acc + r._count._all, 0);

    // ⚠️ FAILED est volontairement HORS du taux de retenue : un échec technique n'est pas
    // une décision du système. Les additionner masquerait une panne d'envoi derrière un
    // taux de suppression qui paraîtrait normal.
    const withheld = suppressed + grouped;
    const suppressionRate = total > 0 ? withheld / total : 0;

    const byReason: NotificationSuppressionReasonDto[] = byReasonRows
      .map((r) => {
        const reason = r.reason ?? 'inconnu';
        return {
          reason,
          label: this.labelForReason(r.reason) ?? 'Motif non renseigné',
          count: r._count._all,
          share: withheld > 0 ? r._count._all / withheld : 0,
        };
      })
      .sort((a, b) => b.count - a.count);

    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      windowDays: this.windowDays(window),
      total,
      sent,
      failed,
      suppressed,
      grouped,
      withheld,
      suppressionRate,
      byReason,
      byStatus: this.toCounts(
        byStatusRows.map((r) => ({ key: r.status, count: r._count._all })),
        (key) => NOTIFICATION_STATUS_LABELS[key as keyof typeof NOTIFICATION_STATUS_LABELS] ?? key,
      ),
      byChannel: this.toCounts(
        byChannelRows.map((r) => ({ key: r.channel, count: r._count._all })),
        // Un canal inconnu du contrat sort BRUT plutôt que masqué : mieux vaut lire
        // 'TELEGRAM' que « autre » le jour où un canal est journalisé avant d'être nommé.
        (key) => NOTIFICATION_CHANNEL_LABELS[key as NotificationChannel] ?? key,
      ),
      bySeverity: this.toCounts(
        // La colonne est un texte libre : 'CRITICAL' et 'critical' désignent la même chose
        // et doivent compter ensemble, sinon la répartition se coupe en deux au premier
        // écrit qui n'aurait pas normalisé.
        bySeverityRows.map((r) => ({
          key: this.normalizeSeverity(r.severity) ?? 'inconnue',
          count: r._count._all,
        })),
        // Le libellé est calculé ICI parce que le contrat le promet « prêt à afficher » :
        // renvoyer `label === key` obligerait l'écran à se refaire sa propre table de
        // traduction — c'est-à-dire une seconde vérité, qui divergera.
        (key) => NOTIFICATION_SEVERITY_LABELS[key as AlertSeverity] ?? 'Sévérité non renseignée',
      ),
      byAlertType: this.toCounts(
        byTypeRows.map((r) => ({ key: r.alertType ?? 'hors alerte', count: r._count._all })),
      ).slice(0, TOP_ALERT_TYPES),
      // Répartition par FAMILLE. Elle répond à une question que « par type d'alerte » ne
      // peut plus couvrir depuis que le journal reçoit autre chose que des alertes : un
      // rappel d'entretien y tombait dans « hors alerte », indistinct d'un envoi de test.
      byCategory: this.toCounts(
        byCategoryRows.map((r) => ({
          key: isNotificationCategory(r.category) ? r.category : 'ALERT',
          count: r._count._all,
        })),
        (key) => NOTIFICATION_CATEGORY_LABELS[key as NotificationCategory] ?? key,
      ),
      topRecipients: await this.topRecipients(byRecipientRows),
      headline: this.headline({ total, sent, withheld, byReason }),
    };
  }

  // ─── Santé de la chaîne ────────────────────────────────────────────────────────────

  /**
   * État de bout en bout : VAPID, périmètre de déploiement, appareils réellement abonnés,
   * dernier push accepté, et — le trou classique — les utilisateurs ÉLIGIBLES qui n'ont
   * aucun appareil.
   *
   * Ce dernier point est celui qui coûte des semaines : la personne a des préférences bien
   * réglées, l'écran lui dit que tout va bien, elle attend des alertes… et elle n'a jamais
   * autorisé les notifications dans son navigateur. Rien, côté serveur, ne s'en plaint.
   * On le rend donc explicite et nominatif.
   */
  async health(viewer: Viewer = {}): Promise<NotificationHealthDto> {
    const rollout = this.rollout();
    const vapidConfigured = this.webPush.isEnabled();

    // Exclusion owner appliquée sur la clé primaire des users (et non sur `userId`).
    const ownerOnUserId = await this.ownerVis.userIdExclusion(viewer, 'id');
    const hidden = new Set(await this.ownerVis.hiddenIdsFor(viewer));
    const deliveryWhere = await this.ownerScopedDeliveryWhere(viewer);

    const [subsByUser, usersByRole, lastSent, lastAttempt] = await Promise.all([
      this.prisma.pushSubscription.groupBy({ by: ['userId'], _count: { _all: true } }),
      this.prisma.user.groupBy({
        by: ['role'],
        where: { isActive: true, ...ownerOnUserId },
        _count: { _all: true },
      }),
      this.prisma.notificationDelivery.findFirst({
        where: this.and(deliveryWhere, { channel: 'WEB_PUSH', status: 'SENT' }),
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.notificationDelivery.findFirst({
        // Une TENTATIVE (réussie ou en échec) : sans cette seconde date, « rien reçu » et
        // « rien envoyé » se ressemblent, alors qu'ils ne se corrigent pas au même endroit.
        where: this.and(deliveryWhere, { channel: 'WEB_PUSH', status: { in: ['SENT', 'FAILED'] } }),
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    const visibleSubs = subsByUser.filter((s) => !hidden.has(s.userId));
    const subscribedIds = visibleSubs.map((s) => s.userId);
    const devicesByUser = new Map(visibleSubs.map((s) => [s.userId, s._count._all]));

    // Rôles des abonnés : la liste est courte (14 appareils en production), une seule
    // requête suffit à la croiser avec le décompte par rôle.
    //
    // ⚠️ `isActive: true` n'est pas un détail de confort. Les abonnements push ne sont JAMAIS
    // purgés à la désactivation d'un compte (seulement au désabonnement, au 410 Gone ou à la
    // révocation d'un appareil) : l'appareil d'un ex-salarié reste donc en base. Or le
    // dispatch ne cible que des comptes actifs (`isActive: true` sur les quatre requêtes de
    // destinataires). Les compter ici ferait dire à l'écran « X appareils joignables » pour
    // des appareils que rien ne visera jamais — et pire, ferait taire l'avertissement
    // « aucun appareil abonné » alors que plus personne n'est réellement joignable.
    // Effet de bord corrigé au passage : un rôle pouvait afficher `usersWithDevice` > `users`,
    // puisque le décompte par rôle, lui, filtrait déjà sur les comptes actifs.
    const subscribers =
      subscribedIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: subscribedIds }, isActive: true },
            select: { id: true, role: true },
          })
        : [];

    const withDeviceIds = subscribers.map((s) => s.id);
    const totalDevices = subscribers.reduce((acc, s) => acc + (devicesByUser.get(s.id) ?? 0), 0);

    const reach = new Map<string, NotificationRoleReachDto>();
    for (const r of usersByRole) {
      reach.set(String(r.role), {
        role: String(r.role),
        users: r._count._all,
        usersWithDevice: 0,
        devices: 0,
      });
    }
    for (const s of subscribers) {
      const key = String(s.role);
      const entry = reach.get(key) ?? { role: key, users: 0, usersWithDevice: 0, devices: 0 };
      entry.usersWithDevice += 1;
      entry.devices += devicesByUser.get(s.id) ?? 0;
      reach.set(key, entry);
    }

    // Périmètre courant : en `SUPER_ADMIN_ONLY` (le défaut, et l'état de la production),
    // seuls les super-admins sont concernés. On interroge donc EXACTEMENT la population
    // que le dispatch retiendrait — pas « tous les utilisateurs », qui gonflerait le
    // compteur d'injoignables avec des gens qui ne devaient rien recevoir de toute façon.
    //
    // La question « le périmètre est-il ouvert ? » est posée à `isPushRoleEligible` avec un
    // rôle témoin NON super-admin, plutôt que comparée à la chaîne 'ALL' ici : la règle de
    // rollout n'a qu'UNE implémentation (celle du dispatch). Si elle change, cet écran
    // suit automatiquement au lieu d'affirmer le contraire de ce qui se passe réellement.
    const eligibleWhere: Prisma.UserWhereInput = {
      isActive: true,
      ...ownerOnUserId,
      ...(isPushRoleEligible(UserRole.FLEET_ADMIN, rollout) ? {} : { role: UserRole.SUPER_ADMIN }),
    };
    const withoutDeviceWhere: Prisma.UserWhereInput =
      withDeviceIds.length > 0
        ? { ...eligibleWhere, AND: [{ id: { notIn: withDeviceIds } }] }
        : eligibleWhere;

    const [eligibleUsers, eligibleWithoutDevice, unreachable] = await Promise.all([
      this.prisma.user.count({ where: eligibleWhere }),
      this.prisma.user.count({ where: withoutDeviceWhere }),
      this.prisma.user.findMany({
        where: withoutDeviceWhere,
        orderBy: { email: 'asc' },
        take: UNREACHABLE_SAMPLE,
        select: { id: true, email: true, firstName: true, lastName: true, role: true },
      }),
    ]);

    return {
      vapidConfigured,
      pushRollout: rollout,
      totalDevices,
      usersWithDevice: subscribers.length,
      reachByRole: [...reach.values()].sort((a, b) => b.users - a.users),
      lastSuccessfulPushAt: lastSent?.createdAt.toISOString() ?? null,
      lastAttemptAt: lastAttempt?.createdAt.toISOString() ?? null,
      eligibleUsers,
      eligibleWithoutDevice,
      unreachableUsers: unreachable.map((u) => ({
        userId: u.id,
        email: u.email,
        name: this.displayName(u.firstName, u.lastName),
        role: String(u.role),
      })),
      warnings: this.healthWarnings({
        vapidConfigured,
        rollout,
        totalDevices,
        eligibleWithoutDevice,
        lastSuccessfulPushAt: lastSent?.createdAt ?? null,
      }),
    };
  }

  // ─── Construction des filtres ──────────────────────────────────────────────────────

  /**
   * `where` commun aux trois lectures. Deux invariants non négociables :
   *   - la période est TOUJOURS présente (jamais de scan intégral de la table) ;
   *   - l'exclusion owner passe par `AND`, jamais par un étalement au premier niveau, sinon
   *     un filtre `userId=<owner>` fourni par l'appelant écraserait le masquage et
   *     rendrait visible le compte qu'on masque.
   */
  private async buildWhere(
    query: NotificationDeliveryQueryDto,
    window: { from: Date; to: Date },
    viewer: Viewer,
  ): Promise<Prisma.NotificationDeliveryWhereInput> {
    const where: Prisma.NotificationDeliveryWhereInput = {
      createdAt: { gte: window.from, lte: window.to },
    };
    const and: Prisma.NotificationDeliveryWhereInput[] = [];

    const ownerExcl = await this.ownerVis.userIdExclusion(viewer, 'userId');
    if (Object.keys(ownerExcl).length > 0) {
      and.push(ownerExcl as Prisma.NotificationDeliveryWhereInput);
    }

    if (query.status) where.status = this.assertEnum(query.status, NOTIFICATION_DELIVERY_STATUSES, 'statut');
    // Canal et type d'alerte restent PERMISSIFS (pas de liste blanche) : une valeur
    // inconnue ne peut que RESTREINDRE le résultat — le pire cas est « 0 ligne », visible
    // immédiatement. Les valider figerait au contraire l'écran au premier canal ou type
    // journalisé avant que le contrat partagé ne le connaisse.
    if (query.channel) where.channel = String(query.channel).toUpperCase();
    if (query.category) where.category = String(query.category).toUpperCase();
    if (query.alertType) where.alertType = String(query.alertType).toUpperCase();
    if (query.reason) where.reason = String(query.reason);
    if (query.userId) where.userId = query.userId;
    if (query.fleetId) where.fleetId = query.fleetId;

    if (query.severity) {
      const normalized = this.normalizeSeverity(query.severity);
      if (!normalized) {
        throw new BadRequestException(`Sévérité inconnue — attendu : ${SEVERITY_ORDER.join(', ')}`);
      }
      // La colonne est un texte libre alimenté par plusieurs chemins : on accepte les deux
      // casses plutôt que de renvoyer « 0 résultat » sur une différence de majuscules.
      where.severity = { in: [normalized, normalized.toUpperCase()] };
    }

    if (query.search) {
      const term = String(query.search).trim();
      if (term.length > 0) {
        and.push({
          OR: [
            { title: { contains: term, mode: 'insensitive' } },
            { body: { contains: term, mode: 'insensitive' } },
            // L'e-mail est le point d'entrée naturel du diagnostic (« untel dit ne rien
            // recevoir ») : on cherche dessus sans imposer de connaître son UUID.
            { user: { email: { contains: term, mode: 'insensitive' } } },
          ],
        });
      }
    }

    if (and.length > 0) where.AND = and;
    return where;
  }

  /** ANDe une condition supplémentaire sans jamais écraser celles déjà posées. */
  private and(
    base: Prisma.NotificationDeliveryWhereInput,
    extra: Prisma.NotificationDeliveryWhereInput,
  ): Prisma.NotificationDeliveryWhereInput {
    const existing = base.AND;
    const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
    return { ...base, AND: [...list, extra] };
  }

  /** `where` réduit au seul masquage owner (santé : pas de filtre métier). */
  private async ownerScopedDeliveryWhere(viewer: Viewer): Promise<Prisma.NotificationDeliveryWhereInput> {
    const excl = await this.ownerVis.userIdExclusion(viewer, 'userId');
    return Object.keys(excl).length > 0 ? (excl as Prisma.NotificationDeliveryWhereInput) : {};
  }

  /**
   * Fenêtre temporelle bornée.
   *
   * Une période absente donne 7 jours ; une période démesurée est RAMENÉE à 90 jours au
   * lieu d'être refusée — l'écran reste utilisable et la base protégée. Une borne
   * illisible est ignorée plutôt que de faire échouer la page : une date mal formée dans
   * une URL ne doit pas transformer un tableau de bord en erreur 400.
   */
  private resolveWindow(from?: string, to?: string): { from: Date; to: Date } {
    const now = new Date();
    const parsedTo = this.parseDate(to) ?? now;
    const defaultFrom = new Date(parsedTo.getTime() - NOTIFICATION_DEFAULT_WINDOW_DAYS * 86_400_000);
    let parsedFrom = this.parseDate(from) ?? defaultFrom;

    if (parsedFrom > parsedTo) {
      // Bornes inversées : on retombe sur la fenêtre par défaut plutôt que de renvoyer un
      // ensemble vide, qui se lirait à tort comme « aucune notification ».
      parsedFrom = defaultFrom;
    }

    const maxSpan = NOTIFICATION_MAX_WINDOW_DAYS * 86_400_000;
    if (parsedTo.getTime() - parsedFrom.getTime() > maxSpan) {
      parsedFrom = new Date(parsedTo.getTime() - maxSpan);
    }
    return { from: parsedFrom, to: parsedTo };
  }

  private parseDate(value?: string): Date | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private windowDays(window: { from: Date; to: Date }): number {
    return Math.max(1, Math.round((window.to.getTime() - window.from.getTime()) / 86_400_000));
  }

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(Math.trunc(value), min), max);
  }

  /** Valeur d'énumération, refusée explicitement si inconnue (un filtre ignoré en silence
   *  ferait croire à une liste exhaustive alors qu'elle ne l'est pas). */
  private assertEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
    const upper = String(value).toUpperCase() as T;
    if (!allowed.includes(upper)) {
      throw new BadRequestException(`${label} inconnu — attendu : ${allowed.join(', ')}`);
    }
    return upper;
  }

  // ─── Mise en forme ─────────────────────────────────────────────────────────────────

  private toRow(
    row: {
      id: string;
      createdAt: Date;
      category?: string | null;
      alertId: string | null;
      alertType: string | null;
      severity: string | null;
      userId: string;
      fleetId: string | null;
      channel: string;
      status: string;
      reason: string | null;
      title: string | null;
      body: string | null;
      deviceCount: number;
      sentCount: number;
      failedCount: number;
      groupedCount: number;
      user?: { email: string; firstName: string | null; lastName: string | null; role: UserRole | string } | null;
    },
    fleetNames: Map<string, string>,
  ): NotificationDeliveryRowDto {
    // Une ligne antérieure à la migration n'a pas de catégorie en base : c'était une
    // alerte (rien d'autre ne passait par ici à l'époque). On la nomme plutôt que
    // d'afficher un vide qui se lirait comme une donnée manquante.
    const category = isNotificationCategory(row.category) ? row.category : 'ALERT';
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      category,
      categoryLabel: NOTIFICATION_CATEGORY_LABELS[category],
      alertId: row.alertId,
      alertType: row.alertType,
      severity: this.normalizeSeverity(row.severity),
      userId: row.userId,
      userEmail: row.user?.email ?? '(compte supprimé)',
      userName: this.displayName(row.user?.firstName ?? null, row.user?.lastName ?? null),
      userRole: row.user ? String(row.user.role) : 'INCONNU',
      fleetId: row.fleetId,
      fleetName: row.fleetId ? (fleetNames.get(row.fleetId) ?? null) : null,
      channel: row.channel,
      status: row.status,
      statusLabel:
        NOTIFICATION_STATUS_LABELS[row.status as keyof typeof NOTIFICATION_STATUS_LABELS] ?? row.status,
      reason: row.reason,
      // Une ligne SENT n'a rien à expliquer ; toutes les autres DOIVENT dire pourquoi.
      reasonLabel: row.status === 'SENT' ? null : (this.labelForReason(row.reason) ?? 'Motif non renseigné'),
      title: row.title,
      body: row.body,
      deviceCount: row.deviceCount,
      sentCount: row.sentCount,
      failedCount: row.failedCount,
      groupedCount: row.groupedCount,
    };
  }

  /**
   * Motif en clair. Les codes connus passent par `SUPPRESSION_LABELS` (source unique
   * partagée avec la PWA) ; un motif inconnu est renvoyé TEL QUEL plutôt que masqué —
   * un texte brut reste plus utile qu'un « autre » qui n'apprend rien.
   */
  private labelForReason(reason: string | null): string | null {
    if (!reason) return null;
    return SUPPRESSION_LABELS[reason as SuppressionReason] ?? reason;
  }

  private normalizeSeverity(value: string | null | undefined): AlertSeverity | null {
    if (!value) return null;
    const lowered = String(value).toLowerCase();
    return (SEVERITY_ORDER as readonly string[]).includes(lowered) ? (lowered as AlertSeverity) : null;
  }

  private displayName(firstName: string | null, lastName: string | null): string | null {
    const name = [firstName, lastName].filter(Boolean).join(' ').trim();
    return name.length > 0 ? name : null;
  }

  private toCounts(
    entries: { key: string; count: number }[],
    label: (key: string) => string = (k) => k,
  ): NotificationCountDto[] {
    // Fusion par clé : plusieurs lignes peuvent retomber sur la même étiquette après
    // normalisation (casse de la sévérité, valeurs nulles regroupées).
    const merged = new Map<string, number>();
    for (const e of entries) merged.set(e.key, (merged.get(e.key) ?? 0) + e.count);
    return [...merged.entries()]
      .map(([key, count]) => ({ key, label: label(key), count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Classement des destinataires. Sert à repérer le compte qui reçoit 300 notifications
   * par jour — celui-là coupera tout, et on ne le saura qu'en le voyant ici.
   */
  private async topRecipients(
    rows: { userId: string; status: string; _count: { _all: number } }[],
  ): Promise<NotificationTopRecipientDto[]> {
    const byUser = new Map<string, NotificationTopRecipientDto>();
    for (const r of rows) {
      const entry = byUser.get(r.userId) ?? {
        userId: r.userId,
        email: '(compte supprimé)',
        name: null,
        role: 'INCONNU',
        sent: 0,
        failed: 0,
        suppressed: 0,
        grouped: 0,
        total: 0,
      };
      const n = r._count._all;
      if (r.status === 'SENT') entry.sent += n;
      else if (r.status === 'FAILED') entry.failed += n;
      else if (r.status === 'SUPPRESSED') entry.suppressed += n;
      else if (r.status === 'GROUPED') entry.grouped += n;
      entry.total += n;
      byUser.set(r.userId, entry);
    }

    const top = [...byUser.values()].sort((a, b) => b.total - a.total).slice(0, NOTIFICATION_TOP_RECIPIENTS);
    if (top.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: top.map((t) => t.userId) } },
      select: { id: true, email: true, firstName: true, lastName: true, role: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const t of top) {
      const u = byId.get(t.userId);
      if (!u) continue;
      t.email = u.email;
      t.name = this.displayName(u.firstName, u.lastName);
      t.role = String(u.role);
    }
    return top;
  }

  /**
   * La phrase de résumé, construite ICI et pas dans l'UI : l'écran, un futur e-mail de
   * supervision et un export doivent raconter la même chose, au mot près.
   */
  private headline(input: {
    total: number;
    sent: number;
    withheld: number;
    byReason: NotificationSuppressionReasonDto[];
  }): string {
    if (input.total === 0) return 'Aucune notification sur la période.';
    const top = input.byReason[0];
    const detail =
      input.withheld > 0 && top
        ? ` (dont ${top.count} — ${top.label.toLowerCase()})`
        : '';
    return `${input.total} notifications · ${input.sent} envoyées · ${input.withheld} retenues${detail}`;
  }

  /** Constats bloquants, formulés pour être lisibles tels quels dans un bandeau. */
  private healthWarnings(input: {
    vapidConfigured: boolean;
    rollout: string;
    totalDevices: number;
    eligibleWithoutDevice: number;
    lastSuccessfulPushAt: Date | null;
  }): string[] {
    const warnings: string[] = [];
    if (!input.vapidConfigured) {
      warnings.push('Clés VAPID absentes : aucun push ne peut partir, quels que soient les réglages.');
    }
    if (input.rollout !== 'ALL') {
      warnings.push(
        `Déploiement restreint (PUSH_ROLLOUT=${input.rollout}) : seuls les super-admins reçoivent un push.`,
      );
    }
    if (input.totalDevices === 0) {
      warnings.push('Aucun appareil abonné : personne n’est joignable par notification.');
    }
    if (input.eligibleWithoutDevice > 0) {
      warnings.push(
        `${input.eligibleWithoutDevice} utilisateur(s) éligible(s) sans aucun appareil abonné : ils se croient notifiés et ne le sont pas.`,
      );
    }
    if (!input.lastSuccessfulPushAt) {
      warnings.push('Aucun push accepté à ce jour — la chaîne n’a jamais abouti.');
    } else {
      const days = Math.floor((Date.now() - input.lastSuccessfulPushAt.getTime()) / 86_400_000);
      // 7 jours : c'est exactement la durée pendant laquelle le bug d'origine est passé
      // inaperçu (582 alertes, zéro push). Au-delà, on le dit.
      if (days >= 7) warnings.push(`Dernier push accepté il y a ${days} jours.`);
    }
    return warnings;
  }

  /** Noms de flottes de la page courante (au plus `pageSize` identifiants distincts). */
  private async resolveFleetNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const fleets = await this.prisma.fleet.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(fleets.map((f) => [f.id, f.name]));
  }

  // ─── Rejeu d'une alerte ────────────────────────────────────────────────────────────

  /**
   * Renvoie une alerte DÉJÀ EXISTANTE à ses destinataires légitimes.
   *
   * ── Pourquoi cette méthode existe (incident du 2026-08-03) ──────────────────────────
   * Le gérant d'une flotte n'avait reçu aucune de ses 28 alertes de vitesse, à cause d'un
   * défaut de configuration. Une fois le défaut corrigé, il restait à lui envoyer celle
   * qu'il aurait dû recevoir — et il n'existait AUCUN moyen de le faire. Le seul endpoint
   * d'envoi hors flux (`POST /notifications/test`) est verrouillé deux fois sur le compte
   * appelant, et n'envoie qu'un message générique sans lien avec une alerte.
   *
   * Le contournement tentant — réaffecter l'abonnement du client à un super-admin le temps
   * d'un envoi — est un piège : le plafond de 3 appareils par compte supprime la ligne au
   * `lastSeenAt` le plus ancien au prochain abonnement, c'est-à-dire potentiellement celle
   * du client, qui cesserait de recevoir sans le savoir. On répare une notification
   * manquée en en cassant toutes les suivantes.
   *
   * ── Ce que le rejeu NE contourne PAS ────────────────────────────────────────────────
   * Permissions, périmètre véhicule, préférences, plafond horaire, journalisation : tout
   * passe par `dispatchAlert`, la porte unique. Le rejeu ne peut donc pas envoyer à
   * quelqu'un qui n'y a pas droit, ni à quelqu'un qui a coupé ce type — c'est voulu : un
   * outil d'exploitation qui peut forcer la main de l'utilisateur finit par le faire.
   *
   * ⚠️ Le résultat est lu DANS LE JOURNAL, pas déduit de l'appel. C'est la seule façon de
   * répondre honnêtement à « est-ce parti ? » : si le dispatch retient l'envoi pour une
   * raison quelconque, l'opérateur voit le motif au lieu d'un « OK » trompeur.
   */
  async replayAlert(alertId: string): Promise<{
    alertId: string;
    alertType: string;
    plate: string | null;
    destinataires: Array<{
      email: string;
      status: string;
      reason: string | null;
      reasonLabel: string | null;
      devices: number;
      sent: number;
    }>;
  }> {
    const alert = await this.prisma.alert.findUnique({
      where: { id: alertId },
      include: { vehicle: true },
    });
    if (!alert) throw new NotFoundException('Alerte introuvable');

    // Borne de lecture posée AVANT l'envoi : seules les lignes écrites par CE rejeu sont
    // relues. Sans elle on afficherait les lignes de l'envoi d'origine — donc un rejeu
    // en échec pourrait se présenter comme un succès, en montrant le SENT d'hier.
    const depuis = new Date();
    await this.dispatch.dispatchAlert(alert as AlertWithVehicle, { replay: true });

    const rows = await this.prisma.notificationDelivery.findMany({
      where: { alertId, createdAt: { gte: depuis } },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return {
      alertId,
      alertType: alert.type as string,
      plate: alert.vehicle?.plate ?? null,
      destinataires: rows.map((r) => ({
        email: r.user.email,
        status: r.status,
        reason: r.reason,
        // Helper EXISTANT, pas une seconde table : deux traductions du meme motif
        // divergeraient au premier libelle ajoute, et l'ecran de rejeu dirait autre
        // chose que le journal pour exactement la meme ligne.
        reasonLabel: this.labelForReason(r.reason),
        devices: r.deviceCount,
        sent: r.sentCount,
      })),
    };
  }

  /** Valeur courante de PUSH_ROLLOUT, relue à chaque appel (un redémarrage suffit à basculer). */
  private rollout(): string {
    return this.config.get('PUSH_ROLLOUT', { infer: true }) ?? 'SUPER_ADMIN_ONLY';
  }
}
