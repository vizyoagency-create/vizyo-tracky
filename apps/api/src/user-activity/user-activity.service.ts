import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type {
  ActivityFeedItemDto,
  ActivityStatsDto,
  EngineCommandAuditDto,
  FleetAgendaActivityDto,
  OnlineUserDto,
  PresenceStatus,
} from '@vizyo/tracky-shared';
import { AGENDA_ACTIVITY_ACTION_LABELS, labelForRoute } from '@vizyo/tracky-shared';
import { Prisma, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { OwnerVisibilityService } from '../common/owner-visibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/** Forme lâche d'un event reçu (le `type`/`status` sont validés via les Sets ci-dessous). */
interface ActivityEventLike {
  type: string;
  route?: string;
  routeLabel?: string;
  target?: string;
  durationMs?: number;
  status?: string;
  at?: string;
}

/**
 * Restreint la vue « activité » à une flotte (fleet-admin). Filtre par flotte ET exclut les
 * acteurs de rôle ÉLEVÉ (super-admin / owner). Absent = vue super-admin complète (inchangée).
 */
export interface FleetActivityScope {
  fleetId: string;
}

/** Au-delà de ce silence on rattache à une nouvelle session, pas à l'ancienne. */
const SESSION_GAP_MS = 30 * 60 * 1000;
/** "En ligne" = dernier signal reçu dans cette fenêtre. */
const ONLINE_FRESH_MS = 90 * 1000;
/** Une session ouverte mais sans signal depuis ça est clôturée par le cron. */
const STALE_CLOSE_MS = 5 * 60 * 1000;
const RETENTION_DAYS = 90;

const VALID_TYPES = new Set([
  'PAGE_VIEW',
  'CLICK',
  'SCROLL',
  'FORM_SUBMIT',
  'SESSION_START',
  'SESSION_END',
  'SESSION_RESUME',
  'IDLE',
  'AWAY',
  'HEARTBEAT',
]);
const VALID_STATUS = new Set(['ACTIVE', 'IDLE', 'AWAY']);

/** Identifiant de ligne ou de société : une colonne `@db.Uuid` refuse toute autre forme (erreur 500). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nom affiché d'un geste fait par un super-admin ou le propriétaire de la plateforme (owner caché). */
export const ACTEUR_EQUIPE_TRACKY = 'Équipe Tracky';

/**
 * Lignes du fil « Agenda » d'une société : les deux catégories métier de l'agenda, plus les
 * passages de l'agent (écrits en catégorie AI). `category` optionnelle : RESERVATION = les
 * réservations seules ; AGENDA = le reste de l'agenda, passages de l'agent compris.
 */
function filtreCategoriesAgenda(category?: string): Prisma.SystemActivityLogWhereInput {
  const passagesAgent: Prisma.SystemActivityLogWhereInput = { category: 'AI', action: 'agenda_agent_run' };
  if (category === 'RESERVATION') return { category: 'RESERVATION' };
  if (category === 'AGENDA') return { OR: [{ category: 'AGENDA' }, passagesAgent] };
  // Absente ou inconnue : tout le fil Agenda — jamais au-delà (une catégorie étrangère n'élargit rien).
  return { OR: [{ category: { in: ['RESERVATION', 'AGENDA'] } }, passagesAgent] };
}

function fullName(u: { firstName?: string | null; lastName?: string | null }): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Utilisateur';
}

@Injectable()
export class UserActivityService {
  private readonly logger = new Logger(UserActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemActivity: SystemActivityService,
    private readonly ownerVis: OwnerVisibilityService,
  ) {}

  /** Ingestion d'un batch d'events : résout/crée la session, persiste, met à jour la présence. */
  async ingestBatch(
    user: AuthUser,
    batch: { events: ActivityEventLike[]; deviceType?: string },
    meta: { userAgent?: string } = {},
  ): Promise<void> {
    const events = (batch.events ?? []).filter((e) => VALID_TYPES.has(e.type));
    if (events.length === 0) return;

    const now = new Date();
    const fleetId = user.fleetId ?? null;

    // Résolution de session : réutilise la session ouverte récente, sinon en crée une.
    let session = await this.prisma.userSession.findFirst({
      where: {
        userId: user.id,
        endedAt: null,
        lastSeenAt: { gte: new Date(now.getTime() - SESSION_GAP_MS) },
      },
      orderBy: { lastSeenAt: 'desc' },
    });
    if (!session) {
      session = await this.prisma.userSession.create({
        data: {
          userId: user.id,
          fleetId,
          status: 'ACTIVE',
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
          deviceType: batch.deviceType?.slice(0, 20) ?? null,
        },
      });
    }

    let latestStatus: string | null = null;
    let latestRoute: string | null = session.currentRoute;
    let ended = false;

    const rows = events.map((e) => {
      if (e.status && VALID_STATUS.has(e.status)) latestStatus = e.status;
      // currentRoute vient du HEARTBEAT (porte la route COURANTE) ; le PAGE_VIEW
      // porte la route QUITTÉE (avec sa durée) — ne pas l'utiliser pour le live.
      if (e.type === 'HEARTBEAT' && e.route) latestRoute = e.route;
      if (e.type === 'SESSION_END') ended = true;
      if (e.type === 'SESSION_RESUME') latestStatus = 'ACTIVE';
      return {
        sessionId: session!.id,
        userId: user.id,
        fleetId,
        type: e.type,
        route: e.route?.slice(0, 300) ?? null,
        routeLabel: e.routeLabel?.slice(0, 120) ?? null,
        target: e.target?.slice(0, 120) ?? null,
        durationMs:
          typeof e.durationMs === 'number' && e.durationMs >= 0
            ? Math.min(e.durationMs, 86_400_000)
            : null,
      };
    });

    await this.prisma.userActivity.createMany({ data: rows });
    await this.prisma.userSession.update({
      where: { id: session.id },
      data: {
        lastSeenAt: now,
        status: latestStatus ?? session.status,
        currentRoute: latestRoute,
        ...(ended ? { endedAt: now } : {}),
      },
    });
  }

  /**
   * IDs des utilisateurs de rôle ÉLEVÉ (SUPER_ADMIN ou owner). EXCLUS de la vue fleet-admin :
   * un fleet-admin ne doit JAMAIS voir l'activité des rôles au-dessus de lui (super-admin, owner).
   * Caché 60 s (change rarement). Filtre CÔTÉ SERVEUR, pas un simple masquage d'affichage.
   */
  private elevatedCache: { ids: string[]; at: number } | null = null;
  private async getElevatedUserIds(): Promise<string[]> {
    if (this.elevatedCache && Date.now() - this.elevatedCache.at < 60_000) return this.elevatedCache.ids;
    const rows = await this.prisma.user.findMany({
      where: { OR: [{ role: UserRole.SUPER_ADMIN }, { isOwner: true }] },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    this.elevatedCache = { ids, at: Date.now() };
    return ids;
  }

  /** Utilisateurs en ligne maintenant (1 entrée par user, la session la plus fraîche). */
  async getOnline(
    viewer: { isOwner?: boolean | null } = {},
    scope?: FleetActivityScope,
  ): Promise<OnlineUserDto[]> {
    const fresh = new Date(Date.now() - ONLINE_FRESH_MS);
    const where: Prisma.UserSessionWhereInput = {
      endedAt: null,
      lastSeenAt: { gte: fresh },
      // Owner plateforme — invisible aux autres super-admins dans le live.
      ...(this.ownerVis.isMasked(viewer) ? { user: { isOwner: false } } : {}),
    };
    if (scope) {
      // Vue fleet-admin : bornée à la flotte + EXCLUT les rôles élevés (super-admin/owner).
      where.fleetId = scope.fleetId;
      where.userId = { notIn: await this.getElevatedUserIds() };
    }
    const sessions = await this.prisma.userSession.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
      include: { user: { select: { firstName: true, lastName: true, role: true } } },
    });

    const now = Date.now();
    const seen = new Set<string>();
    const out: OnlineUserDto[] = [];
    for (const s of sessions) {
      if (seen.has(s.userId)) continue; // dédup multi-onglets
      seen.add(s.userId);
      out.push({
        userId: s.userId,
        name: fullName(s.user),
        role: s.user.role,
        fleetId: s.fleetId,
        status: (VALID_STATUS.has(s.status) ? s.status : 'ACTIVE') as PresenceStatus,
        currentRoute: s.currentRoute,
        currentRouteLabel: s.currentRoute ? labelForRoute(s.currentRoute) : null,
        deviceType: s.deviceType,
        sinceMs: now - s.startedAt.getTime(),
        lastSeenSec: Math.round((now - s.lastSeenAt.getTime()) / 1000),
      });
    }
    return out;
  }

  /**
   * Flux chronologique paginé + filtrable (utilisateur / type / période).
   * Cursor COMPOSITE (createdAt, id) : les events d'un même batch (createMany)
   * partagent le même createdAt — un cursor timestamp seul saute les lignes
   * restantes du batch quand la coupe de page tombe au milieu.
   */
  async getFeed(filters: {
    limit?: number;
    before?: string;
    beforeId?: string;
    userId?: string;
    type?: string;
    from?: string;
    to?: string;
  } = {}, viewer: { isOwner?: boolean | null } = {}, scope?: FleetActivityScope): Promise<ActivityFeedItemDto[]> {
    const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    // On exclut HEARTBEAT (purement technique, 1/30s/user) du flux lisible.
    const and: Record<string, unknown>[] = [{ type: { not: 'HEARTBEAT' } }];
    if (filters.userId) and.push({ userId: filters.userId });
    // Owner plateforme — activité de l'owner exclue pour un viewer non-owner.
    const ownerExcl = await this.ownerVis.userIdExclusion(viewer);
    if (Object.keys(ownerExcl).length) and.push(ownerExcl);
    if (scope) {
      // Vue fleet-admin : bornée à la flotte + EXCLUT les rôles élevés (super-admin/owner).
      and.push({ fleetId: scope.fleetId });
      and.push({ userId: { notIn: await this.getElevatedUserIds() } });
    }
    if (filters.type && VALID_TYPES.has(filters.type)) and.push({ type: filters.type });
    if (filters.from) {
      const d = new Date(filters.from);
      if (!Number.isNaN(d.getTime())) and.push({ createdAt: { gte: d } });
    }
    if (filters.to) {
      const d = new Date(filters.to);
      if (!Number.isNaN(d.getTime())) and.push({ createdAt: { lte: d } });
    }
    if (filters.before) {
      const d = new Date(filters.before);
      if (!Number.isNaN(d.getTime())) {
        and.push(
          filters.beforeId
            ? { OR: [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: filters.beforeId } }] }
            : { createdAt: { lt: d } },
        );
      }
    }
    const acts = await this.prisma.userActivity.findMany({
      where: { AND: and },
      // Tiebreak id : fige l'ordre intra-batch (createdAt identiques) + support du cursor.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    const userIds = [...new Set(acts.map((a) => a.userId))];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, fullName(u)]));
    return acts.map((a) => ({
      id: a.id,
      userId: a.userId,
      userName: nameById.get(a.userId) ?? 'Utilisateur',
      type: a.type as ActivityFeedItemDto['type'],
      route: a.route,
      routeLabel: a.routeLabel ?? (a.route ? labelForRoute(a.route) : null),
      target: a.target,
      durationMs: a.durationMs,
      sessionId: a.sessionId,
      at: a.createdAt.toISOString(),
    }));
  }

  /**
   * 29/09 — fil « Agenda » d'UNE société (page Activité de l'administrateur de flotte) : les gestes
   * sur les réservations et l'agenda, lus dans le journal métier `system_activity_logs`.
   *
   * Bornage : `fleetId` de la LIGNE (= la société de la ressource, jamais celle de l'auteur) — un
   * geste d'un super-admin sur la société d'un client y figure donc, sous « Équipe Tracky ».
   *
   * ⚠️ Réponse délibérément pauvre : ni identifiant d'utilisateur, ni `actor`, ni `meta` (qui porte
   * des identifiants internes). L'auteur est résolu ICI en un nom affichable ; l'identité d'un
   * super-admin ou du propriétaire de la plateforme n'est jamais chargée (règle « owner caché »).
   * Cursor composite (createdAt, id), comme les autres fils.
   *
   * Lecteur (`viewer`) : un administrateur de flotte voit les gestes de l'owner, sous « Équipe
   * Tracky » (voulu : la société voit ce qu'on a fait chez elle). Un SUPER_ADMIN non-owner, lui,
   * ne les voit PAS (règle d'OwnerVisibilityService : l'owner est exclu de toutes les vues
   * d'activité des autres super-admins) — sinon l'écart avec /admin/activity › Système, qui les
   * masque, trahirait qu'un compte caché agit. L'exclusion est une clause du `where` (jamais un
   * filtre après coup, qui rendrait des pages courtes et fausserait le curseur) ; elle garde les
   * lignes sans auteur (demande publique, agent, système).
   */
  async getAgendaFeed(
    filters: { limit?: number; before?: string; beforeId?: string; category?: string },
    scope: FleetActivityScope,
    viewer: { role?: UserRole | null; isOwner?: boolean | null } = {},
  ): Promise<FleetAgendaActivityDto[]> {
    // Une société mal formée ne filtrerait rien : Prisma rejetterait la requête (500) — on rend vide.
    if (!scope?.fleetId || !UUID_RE.test(scope.fleetId)) return [];
    const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const and: Prisma.SystemActivityLogWhereInput[] = [
      { fleetId: scope.fleetId },
      filtreCategoriesAgenda(filters.category),
    ];
    if (viewer?.role === UserRole.SUPER_ADMIN) {
      // `{}` pour l'owner lui-même (il voit tout) ; sinon un OR (NULL conservé) → clause du AND.
      const ownerExcl = await this.ownerVis.nullableUserIdExclusion(viewer, 'triggeredByUserId');
      if (Object.keys(ownerExcl).length) and.push(ownerExcl as Prisma.SystemActivityLogWhereInput);
    }
    if (filters.before) {
      const d = new Date(filters.before);
      if (!Number.isNaN(d.getTime())) {
        and.push(
          filters.beforeId && UUID_RE.test(filters.beforeId)
            ? { OR: [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: filters.beforeId } }] }
            : { createdAt: { lt: d } },
        );
      }
    }
    const rows = await this.prisma.systemActivityLog.findMany({
      where: { AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      // `meta` n'est jamais lu : il ne peut donc pas fuir dans la réponse.
      select: {
        id: true,
        createdAt: true,
        category: true,
        action: true,
        status: true,
        actor: true,
        target: true,
        detail: true,
        triggeredByUserId: true,
      },
    });

    // Auteurs : les comptes élevés (super-admin, owner) ne sont JAMAIS chargés — leur nom n'entre
    // pas en mémoire. Les autres le sont avec leur rôle, pour rattraper un compte promu depuis
    // moins d'une minute (cache de getElevatedUserIds) : il resterait « Équipe Tracky ».
    const auteurs = [...new Set(rows.map((r) => r.triggeredByUserId).filter((x): x is string => !!x))];
    const eleves = new Set(auteurs.length ? await this.getElevatedUserIds() : []);
    const aCharger = auteurs.filter((id) => !eleves.has(id));
    const users = aCharger.length
      ? await this.prisma.user.findMany({
          where: { id: { in: aCharger } },
          select: { id: true, firstName: true, lastName: true, fleetId: true, role: true, isOwner: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const auteur = (r: (typeof rows)[number]): Pick<FleetAgendaActivityDto, 'actorName' | 'actorKind'> => {
      if (r.triggeredByUserId) {
        if (eleves.has(r.triggeredByUserId)) return { actorName: ACTEUR_EQUIPE_TRACKY, actorKind: 'team' };
        const u = userById.get(r.triggeredByUserId);
        if (u && (u.role === UserRole.SUPER_ADMIN || u.isOwner)) {
          return { actorName: ACTEUR_EQUIPE_TRACKY, actorKind: 'team' };
        }
        // Compte supprimé, ou rattaché à une AUTRE société (déplacé depuis) : on ne nomme pas
        // quelqu'un qui n'est pas de la maison — pas de nom d'une société à l'autre.
        if (!u || u.fleetId !== scope.fleetId) return { actorName: 'Utilisateur', actorKind: 'user' };
        return { actorName: fullName(u), actorKind: 'user' };
      }
      if (r.actor === 'client') return { actorName: 'Demande publique', actorKind: 'public' };
      if (r.action === 'agenda_agent_run' || r.action.startsWith('proposition_')) {
        return { actorName: "Agent de l'agenda", actorKind: 'agent' };
      }
      return { actorName: 'Tracky', actorKind: 'system' };
    };

    return rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      category: r.category,
      action: r.action,
      actionLabel: AGENDA_ACTIVITY_ACTION_LABELS[r.action] ?? r.action,
      status: r.status,
      ...auteur(r),
      vehiclePlate: r.target,
      detail: r.detail,
    }));
  }

  /** Analytics agrégées sur une fenêtre (défaut : 7 derniers jours). */
  async getStats(fromIso?: string, toIso?: string, viewer: { isOwner?: boolean | null } = {}): Promise<ActivityStatsDto> {
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 7 * 86_400_000);

    // Owner plateforme — exclu des agrégats pour un viewer non-owner. user_sessions
    // ET user_activities portent la même colonne "userId" → un seul fragment réutilisé.
    const ownerIds = this.ownerVis.isMasked(viewer) ? await this.ownerVis.getOwnerIds() : [];
    const notOwner = ownerIds.length ? Prisma.sql`AND "userId" <> ALL(${ownerIds}::uuid[])` : Prisma.empty;

    const [totals, topPages, topClicks, perDay, byType, topForms] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ unique_users: number; total_sessions: number; total_page_views: number; avg_session_sec: number }>
      >`
        SELECT
          (SELECT count(DISTINCT "userId") FROM user_sessions WHERE "startedAt" BETWEEN ${from} AND ${to} ${notOwner})::int AS unique_users,
          (SELECT count(*) FROM user_sessions WHERE "startedAt" BETWEEN ${from} AND ${to} ${notOwner})::int AS total_sessions,
          (SELECT count(*) FROM user_activities WHERE type = 'PAGE_VIEW' AND "createdAt" BETWEEN ${from} AND ${to} ${notOwner})::int AS total_page_views,
          (SELECT COALESCE(avg(EXTRACT(EPOCH FROM (COALESCE("endedAt", "lastSeenAt") - "startedAt"))), 0)
             FROM user_sessions WHERE "startedAt" BETWEEN ${from} AND ${to} ${notOwner})::float8 AS avg_session_sec`,
      // Route NORMALISÉE dans le SQL (query strippée + UUID → :id) : sans ça les vues
      // d'une même page sont éclatées en N lignes ('/vehicles?tab=…', '/vehicles/<uuid>'…)
      // et les compteurs dilués. La route brute reste intacte en base (feed chronologique).
      this.prisma.$queryRaw<Array<{ route: string; views: number; avg_ms: number }>>`
        SELECT regexp_replace(split_part(route, '?', 1),
                 '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', ':id', 'g') AS route,
               count(*)::int AS views, COALESCE(avg("durationMs"), 0)::float8 AS avg_ms
        FROM user_activities
        WHERE type = 'PAGE_VIEW' AND route IS NOT NULL AND "createdAt" BETWEEN ${from} AND ${to} ${notOwner}
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 10`,
      this.prisma.$queryRaw<Array<{ target: string; count: number }>>`
        SELECT target, count(*)::int AS count
        FROM user_activities
        WHERE type = 'CLICK' AND target IS NOT NULL AND "createdAt" BETWEEN ${from} AND ${to} ${notOwner}
        GROUP BY target ORDER BY count(*) DESC LIMIT 10`,
      this.prisma.$queryRaw<Array<{ date: string; count: number }>>`
        SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS date, count(*)::int AS count
        FROM user_sessions WHERE "startedAt" BETWEEN ${from} AND ${to} ${notOwner}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<Array<{ type: string; count: number }>>`
        SELECT type, count(*)::int AS count
        FROM user_activities
        WHERE type <> 'HEARTBEAT' AND "createdAt" BETWEEN ${from} AND ${to} ${notOwner}
        GROUP BY type ORDER BY count(*) DESC`,
      this.prisma.$queryRaw<Array<{ target: string; count: number }>>`
        SELECT target, count(*)::int AS count
        FROM user_activities
        WHERE type = 'FORM_SUBMIT' AND target IS NOT NULL AND "createdAt" BETWEEN ${from} AND ${to} ${notOwner}
        GROUP BY target ORDER BY count(*) DESC LIMIT 10`,
    ]);

    const t = totals[0] ?? { unique_users: 0, total_sessions: 0, total_page_views: 0, avg_session_sec: 0 };
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      uniqueUsers: t.unique_users,
      totalSessions: t.total_sessions,
      totalPageViews: t.total_page_views,
      avgSessionSec: Math.round(t.avg_session_sec),
      topPages: topPages.map((r) => ({
        route: r.route,
        label: labelForRoute(r.route),
        views: r.views,
        avgDurationMs: Math.round(r.avg_ms),
      })),
      topClicks: topClicks.map((r) => ({ target: r.target, count: r.count })),
      sessionsPerDay: perDay.map((r) => ({ date: r.date, count: r.count })),
      eventsByType: byType.map((r) => ({ type: r.type, count: r.count })),
      topForms: topForms.map((r) => ({ target: r.target, count: r.count })),
    };
  }

  /**
   * Audit des commandes moteur (coupe-circuit) — vue admin paginée.
   * `requestedBy` est une colonne String (UUID), pas une FK : on résout les
   * demandeurs en un seul findMany, en filtrant d'abord les valeurs réellement
   * UUID (les sentinelles 'SCHEDULER'/'DEVICE_OBSERVED' éventuelles casseraient
   * le cast uuid de Prisma).
   */
  async getEngineCommands(filters: {
    limit?: number;
    before?: string;
    action?: string;
    status?: string;
  }, viewer: { isOwner?: boolean | null } = {}, scope?: FleetActivityScope): Promise<EngineCommandAuditDto[]> {
    const take = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const where: Prisma.EngineControlCommandWhereInput = {};
    if (filters.action === 'CUT' || filters.action === 'RESTORE') where.action = filters.action;
    if (
      filters.status === 'PENDING' ||
      filters.status === 'SENT' ||
      filters.status === 'ACKNOWLEDGED' ||
      filters.status === 'FAILED' ||
      filters.status === 'REJECTED_SPEED'
    ) {
      where.status = filters.status;
    }
    if (filters.before) {
      const d = new Date(filters.before);
      if (!Number.isNaN(d.getTime())) where.createdAt = { lt: d };
    }
    if (scope) {
      // Vue fleet-admin : UNIQUEMENT les commandes des véhicules de SA flotte (via
      // tracker → vehicle → fleetId, la commande ne porte pas de fleetId), et JAMAIS celles
      // demandées par un rôle ÉLEVÉ (super-admin/owner) — un fleet-admin ne voit pas au-dessus.
      where.tracker = { vehicle: { fleetId: scope.fleetId } };
      const elevated = await this.getElevatedUserIds();
      if (elevated.length) where.requestedBy = { notIn: elevated };
    } else if (this.ownerVis.isMasked(viewer)) {
      // Vue super-admin — commandes moteur demandées par l'owner exclues pour un viewer
      // non-owner (`requestedBy` est une colonne UUID, notIn est sûr).
      const ids = await this.ownerVis.getOwnerIds();
      if (ids.length) where.requestedBy = { notIn: ids };
    }

    const commands = await this.prisma.engineControlCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        tracker: { select: { imei: true, vehicle: { select: { plate: true } } } },
      },
    });

    // Résolution du demandeur : seules les valeurs UUID-like sont requêtables.
    const validIds = [
      ...new Set(commands.map((c) => c.requestedBy).filter((id) => UUID_RE.test(id))),
    ];
    const users = validIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: validIds } },
          select: { id: true, firstName: true, lastName: true, role: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    return commands.map((c) => {
      const u = userById.get(c.requestedBy);
      const requestedByName =
        (u ? fullName(u) : null) ??
        (c.source === 'SCHEDULER'
          ? 'Planning'
          : c.source === 'DEVICE_OBSERVED'
            ? 'Boîtier'
            : 'Système');
      return {
        id: c.id,
        action: c.action as EngineCommandAuditDto['action'],
        status: c.status as EngineCommandAuditDto['status'],
        vehiclePlate: c.tracker.vehicle?.plate ?? null,
        trackerImei: c.tracker.imei,
        requestedByName,
        requestedByRole: u?.role ?? null,
        source: c.source,
        reason: c.reason,
        confirmationExpected: c.confirmationExpected,
        channel: c.channel,
        lastError: c.lastError,
        createdAt: c.createdAt.toISOString(),
        sentAt: c.sentAt ? c.sentAt.toISOString() : null,
        ackedAt: c.ackedAt ? c.ackedAt.toISOString() : null,
      };
    });
  }

  /** Clôt les sessions ouvertes sans signal récent (filet : onglet fermé sans beacon). */
  @Cron('30 */2 * * * *')
  async closeStaleSessions(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_CLOSE_MS);
    try {
      await this.prisma.$executeRaw`
        UPDATE user_sessions SET "endedAt" = "lastSeenAt"
        WHERE "endedAt" IS NULL AND "lastSeenAt" < ${cutoff}`;
    } catch (e) {
      this.logger.error('closeStaleSessions failed', e as Error);
    }
  }

  /** Purge l'historique > 90j. */
  @Cron('0 15 4 * * *')
  async purgeOld(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    try {
      const acts = await this.prisma.userActivity.deleteMany({ where: { createdAt: { lt: cutoff } } });
      const sess = await this.prisma.userSession.deleteMany({
        where: { startedAt: { lt: cutoff }, endedAt: { not: null } },
      });
      if (acts.count || sess.count) {
        this.logger.log(`Purged ${acts.count} activities + ${sess.count} sessions > ${RETENTION_DAYS}j`);
        // Purge destructive de l'historique affiché dans /admin/activity → tracée
        // comme les autres purges (positions, logs).
        this.systemActivity.record({
          category: 'RETENTION',
          action: 'user_activity_purged',
          status: 'SUCCESS',
          actor: 'retention-cron',
          target: `${acts.count} activité(s) + ${sess.count} session(s)`,
          detail: `Purge > ${RETENTION_DAYS}j`,
          meta: { activities: acts.count, sessions: sess.count, retentionDays: RETENTION_DAYS },
        });
      }
    } catch (e) {
      this.logger.error('purgeOld failed', e as Error);
    }
  }
}
