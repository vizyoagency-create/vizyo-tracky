import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type {
  ActivityFeedItemDto,
  ActivityStatsDto,
  EngineCommandAuditDto,
  OnlineUserDto,
  PresenceStatus,
} from '@vizyo/tracky-shared';
import { labelForRoute } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';

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

function fullName(u: { firstName?: string | null; lastName?: string | null }): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Utilisateur';
}

@Injectable()
export class UserActivityService {
  private readonly logger = new Logger(UserActivityService.name);

  constructor(private readonly prisma: PrismaService) {}

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

  /** Utilisateurs en ligne maintenant (1 entrée par user, la session la plus fraîche). */
  async getOnline(): Promise<OnlineUserDto[]> {
    const fresh = new Date(Date.now() - ONLINE_FRESH_MS);
    const sessions = await this.prisma.userSession.findMany({
      where: { endedAt: null, lastSeenAt: { gte: fresh } },
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

  /** Flux chronologique paginé (cursor `before` = timestamp ISO). */
  async getFeed(limit = 50, beforeIso?: string): Promise<ActivityFeedItemDto[]> {
    const take = Math.min(Math.max(limit, 1), 200);
    // On exclut HEARTBEAT (purement technique, 1/30s/user) du flux lisible.
    const where: { type: { not: string }; createdAt?: { lt: Date } } = { type: { not: 'HEARTBEAT' } };
    if (beforeIso) where.createdAt = { lt: new Date(beforeIso) };
    const acts = await this.prisma.userActivity.findMany({
      where,
      orderBy: { createdAt: 'desc' },
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
      at: a.createdAt.toISOString(),
    }));
  }

  /** Analytics agrégées sur une fenêtre (défaut : 7 derniers jours). */
  async getStats(fromIso?: string, toIso?: string): Promise<ActivityStatsDto> {
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 7 * 86_400_000);

    const [totals, topPages, topClicks, perDay] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ unique_users: number; total_sessions: number; total_page_views: number; avg_session_sec: number }>
      >`
        SELECT
          (SELECT count(DISTINCT "userId") FROM user_sessions WHERE "startedAt" BETWEEN ${from} AND ${to})::int AS unique_users,
          (SELECT count(*) FROM user_sessions WHERE "startedAt" BETWEEN ${from} AND ${to})::int AS total_sessions,
          (SELECT count(*) FROM user_activities WHERE type = 'PAGE_VIEW' AND "createdAt" BETWEEN ${from} AND ${to})::int AS total_page_views,
          (SELECT COALESCE(avg(EXTRACT(EPOCH FROM (COALESCE("endedAt", "lastSeenAt") - "startedAt"))), 0)
             FROM user_sessions WHERE "startedAt" BETWEEN ${from} AND ${to})::float8 AS avg_session_sec`,
      this.prisma.$queryRaw<Array<{ route: string; views: number; avg_ms: number }>>`
        SELECT route, count(*)::int AS views, COALESCE(avg("durationMs"), 0)::float8 AS avg_ms
        FROM user_activities
        WHERE type = 'PAGE_VIEW' AND route IS NOT NULL AND "createdAt" BETWEEN ${from} AND ${to}
        GROUP BY route ORDER BY count(*) DESC LIMIT 10`,
      this.prisma.$queryRaw<Array<{ target: string; count: number }>>`
        SELECT target, count(*)::int AS count
        FROM user_activities
        WHERE type = 'CLICK' AND target IS NOT NULL AND "createdAt" BETWEEN ${from} AND ${to}
        GROUP BY target ORDER BY count(*) DESC LIMIT 10`,
      this.prisma.$queryRaw<Array<{ date: string; count: number }>>`
        SELECT to_char(date_trunc('day', "startedAt"), 'YYYY-MM-DD') AS date, count(*)::int AS count
        FROM user_sessions WHERE "startedAt" BETWEEN ${from} AND ${to}
        GROUP BY 1 ORDER BY 1`,
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
  }): Promise<EngineCommandAuditDto[]> {
    const take = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const where: {
      action?: 'CUT' | 'RESTORE';
      status?: 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'FAILED' | 'REJECTED_SPEED';
      createdAt?: { lt: Date };
    } = {};
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

    const commands = await this.prisma.engineControlCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        tracker: { select: { imei: true, vehicle: { select: { plate: true } } } },
      },
    });

    // Résolution du demandeur : seules les valeurs UUID-like sont requêtables.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
      }
    } catch (e) {
      this.logger.error('purgeOld failed', e as Error);
    }
  }
}
