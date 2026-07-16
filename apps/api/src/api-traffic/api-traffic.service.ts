import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  ApiTrafficEntryDto,
  ApiTrafficSummaryDto,
  IpIntelligenceRowDto,
} from '@vizyo/tracky-shared';
import { OwnerVisibilityService } from '../common/owner-visibility.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';

/** Entrée d'écriture d'une ligne de trafic (REQUEST) ou d'un beacon (PARTNER_EVENT). */
export interface ApiTrafficRecordInput {
  kind: 'REQUEST' | 'PARTNER_EVENT';
  /** Origine explicite ; sinon déduite de `origin` (Origin/Referer) + `path`. */
  source?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  action?: string | null;
  target?: string | null;
  ip?: string | null;
  userId?: string | null;
  userAgent?: string | null;
  durationMs?: number | null;
  meta?: Record<string, unknown> | null;
  /** Header Origin/Referer — sert à résoudre `source` quand `source` n'est pas explicite. */
  origin?: string | null;
}

const VALID_SOURCES = ['LP', 'MAESTROO', 'API', 'WEBHOOK', 'UNKNOWN'];

/**
 * Observabilité du trafic API PUBLIC + intelligence IP (demande client 2026-07).
 *
 * `record()` est FIRE-AND-FORGET (comme SystemActivityService) : aucun `await` requis,
 * il ne jette JAMAIS — un échec du journal ne casse pas la requête observée. Alimenté par
 * ApiTrafficInterceptor (hits publics / non authentifiés + corpus IP connues) et par le
 * beacon public POST /api/partner/activity.
 *
 * `ipKnown` sépare le trafic « connu » de l'« inconnu » : une IP est reconnue si elle
 * figure dans les leads LP récents OU a déjà été vue liée à un utilisateur authentifié.
 */
@Injectable()
export class ApiTrafficService {
  private readonly logger = new Logger(ApiTrafficService.name);

  /** Ensemble des IP « reconnues » (leads LP + IP d'appels authentifiés), caché ~60 s. */
  private knownIpsCache: { at: number; set: Set<string> } | null = null;
  private readonly knownTtlMs = 60_000;
  private readonly knownWindowDays = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerVis: OwnerVisibilityService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  // ── Écriture (fire-and-forget) ─────────────────────────────────────────────

  /** Enregistre une ligne de trafic. Ne bloque pas et n'échoue JAMAIS dans l'appelant. */
  record(input: ApiTrafficRecordInput): void {
    // Défense en profondeur : capture même une erreur SYNCHRONE (client Prisma désynchronisé
    // → `apiTrafficLog` absent) que le `.catch` sur la promesse ne verrait pas. Les deux chemins
    // remontent au centre d'alerte (recordBackground : dédup + jamais bloquant) — sinon un échec
    // d'écriture d'observabilité serait lui-même une erreur fantôme.
    try {
      void this.persist(input).catch((e) =>
        this.errorLogger.recordBackground(
          e instanceof Error ? e : new Error(String(e)),
          'api-traffic',
          { note: 'échec écriture ligne de trafic (REQUEST/PARTNER_EVENT)' },
        ),
      );
    } catch (e) {
      this.errorLogger.recordBackground(
        e instanceof Error ? e : new Error(String(e)),
        'api-traffic',
        { note: 'record() a jeté de façon synchrone' },
      );
    }
  }

  private async persist(input: ApiTrafficRecordInput): Promise<void> {
    const ip = input.ip ? input.ip.slice(0, 64) : null;
    const userId = input.userId ?? null;
    // Un appel authentifié EST par définition l'IP d'un utilisateur reconnu ; sinon on teste
    // l'appartenance au corpus des IP reconnues (cache court, évite une requête par hit).
    const ipKnown = userId ? true : ip ? (await this.loadKnownIps()).has(ip) : false;

    await this.prisma.apiTrafficLog.create({
      data: {
        kind: input.kind,
        source: this.resolveSource(input),
        method: input.method ? input.method.slice(0, 10) : null,
        path: input.path ? input.path.slice(0, 300) : null,
        statusCode: typeof input.statusCode === 'number' ? input.statusCode : null,
        action: input.action ? input.action.slice(0, 60) : null,
        target: input.target ? input.target.slice(0, 120) : null,
        ip,
        ipKnown,
        userId,
        userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
        durationMs:
          typeof input.durationMs === 'number' ? Math.max(0, Math.round(input.durationMs)) : null,
        meta: (input.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /**
   * Sanitize + enregistre un beacon d'activité partenaire (kind='PARTNER_EVENT').
   * Tolérant (entrée publique non fiable) : tous les champs sont tronqués, meta bornée.
   */
  recordPartnerBeacon(
    raw: unknown,
    ctx: { ip?: string | null; userAgent?: string | null; origin?: string | null },
  ): void {
    const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const source = this.str(body.source, 20);
    const target = this.str(body.target, 80);
    const label = this.str(body.label, 120);
    const sessionId = this.str(body.sessionId, 64);
    const action = this.str(body.action, 60) || 'unknown';
    const durationMs =
      typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
        ? Math.max(0, Math.round(body.durationMs))
        : null;

    this.record({
      kind: 'PARTNER_EVENT',
      source: source || null,
      action,
      target: target || label || null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      origin: ctx.origin ?? null,
      durationMs,
      meta: this.boundMeta(body.meta, { label, sessionId }),
    });
  }

  // ── Lecture admin ──────────────────────────────────────────────────────────

  /** Feed admin (SUPER_ADMIN) — trafic récent, curseur composite (createdAt, id). */
  async getFeed(
    opts: {
      limit?: number;
      before?: string;
      beforeId?: string;
      source?: string;
      kind?: string;
      /** classe HTTP '2xx'..'5xx' OU code exact. */
      status?: string;
      ipKnown?: boolean;
    } = {},
    viewer: { isOwner?: boolean | null } = {},
  ): Promise<ApiTrafficEntryDto[]> {
    const take = Math.min(Math.max(opts.limit ?? 60, 1), 200);
    const where: Prisma.ApiTrafficLogWhereInput = {};
    if (opts.source) where.source = opts.source.toUpperCase();
    if (opts.kind) where.kind = opts.kind.toUpperCase();
    if (typeof opts.ipKnown === 'boolean') where.ipKnown = opts.ipKnown;
    const statusFilter = this.statusClassFilter(opts.status);
    if (statusFilter !== undefined) where.statusCode = statusFilter;

    if (opts.before) {
      const d = new Date(opts.before);
      if (!Number.isNaN(d.getTime())) {
        if (opts.beforeId) {
          where.OR = [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: opts.beforeId } }];
        } else {
          where.createdAt = { lt: d };
        }
      }
    }
    // Owner plateforme — appels de l'owner masqués pour un viewer non-owner (le champ userId
    // est NULLABLE : on conserve les lignes NULL et on n'exclut QUE les owners).
    const ownerExcl = await this.ownerVis.nullableUserIdExclusion(viewer, 'userId');
    if (Object.keys(ownerExcl).length) where.AND = [ownerExcl as Prisma.ApiTrafficLogWhereInput];

    const rows = await this.prisma.apiTrafficLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });

    const names = await this.resolveUserNames(rows.map((r) => r.userId));
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      kind: r.kind,
      source: r.source,
      method: r.method,
      path: r.path,
      statusCode: r.statusCode,
      action: r.action,
      target: r.target,
      ip: r.ip,
      ipKnown: r.ipKnown,
      userId: r.userId,
      userName: r.userId ? (names.get(r.userId) ?? null) : null,
      userAgent: r.userAgent,
      durationMs: r.durationMs,
    }));
  }

  /**
   * Intelligence IP — agrégat par IP sur la fenêtre : fréquence, première/dernière vue,
   * reconnue ou non (+ nom si résolu), origines, répartition des statuts, dernier chemin/UA.
   * Agrégation en mémoire sur les N hits les plus récents de la fenêtre (table neuve, faible volume).
   */
  async getIpIntelligence(
    opts: { windowDays?: number } = {},
    viewer: { isOwner?: boolean | null } = {},
  ): Promise<IpIntelligenceRowDto[]> {
    const windowDays = Math.min(Math.max(opts.windowDays ?? 7, 1), 90);
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const where: Prisma.ApiTrafficLogWhereInput = { createdAt: { gte: since }, ip: { not: null } };
    const ownerExcl = await this.ownerVis.nullableUserIdExclusion(viewer, 'userId');
    if (Object.keys(ownerExcl).length) where.AND = [ownerExcl as Prisma.ApiTrafficLogWhereInput];

    const rows = await this.prisma.apiTrafficLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 20_000,
      select: {
        ip: true,
        createdAt: true,
        source: true,
        statusCode: true,
        path: true,
        userAgent: true,
        userId: true,
        ipKnown: true,
      },
    });

    interface Agg {
      ip: string;
      count: number;
      firstSeen: Date;
      lastSeen: Date;
      known: boolean;
      sources: Set<string>;
      statuses: Record<string, number>;
      lastPath: string | null;
      lastUserAgent: string | null;
      lastUserId: string | null;
    }
    const map = new Map<string, Agg>();
    for (const r of rows) {
      const ip = r.ip;
      if (!ip) continue;
      let a = map.get(ip);
      if (!a) {
        a = {
          ip,
          count: 0,
          firstSeen: r.createdAt,
          lastSeen: r.createdAt,
          known: false,
          sources: new Set(),
          statuses: {},
          lastPath: null,
          lastUserAgent: null,
          lastUserId: null,
        };
        map.set(ip, a);
      }
      a.count++;
      if (r.createdAt < a.firstSeen) a.firstSeen = r.createdAt;
      if (r.createdAt > a.lastSeen) a.lastSeen = r.createdAt;
      // Lignes triées desc → la 1re vue par IP est la plus récente : on fige lastX au 1er passage.
      if (a.lastPath === null && r.path) a.lastPath = r.path;
      if (a.lastUserAgent === null && r.userAgent) a.lastUserAgent = r.userAgent;
      if (a.lastUserId === null && r.userId) a.lastUserId = r.userId;
      if (r.ipKnown) a.known = true;
      if (r.source) a.sources.add(r.source);
      const code = r.statusCode == null ? 'n/a' : String(r.statusCode);
      a.statuses[code] = (a.statuses[code] ?? 0) + 1;
    }

    const knownSet = await this.loadKnownIps();
    const aggs = [...map.values()].sort((x, y) => y.count - x.count).slice(0, 250);

    const userNames = await this.resolveUserNames(aggs.map((a) => a.lastUserId));
    // Prospects LP reconnus par IP (nom/société), pour les IP connues SANS utilisateur app.
    const leadNames = await this.resolveLeadNames(
      aggs.filter((a) => (a.known || knownSet.has(a.ip)) && !a.lastUserId).map((a) => a.ip),
    );

    return aggs.map((a) => {
      const known = a.known || knownSet.has(a.ip);
      const knownUserName = a.lastUserId
        ? (userNames.get(a.lastUserId) ?? null)
        : known
          ? (leadNames.get(a.ip) ?? null)
          : null;
      return {
        ip: a.ip,
        count: a.count,
        firstSeen: a.firstSeen.toISOString(),
        lastSeen: a.lastSeen.toISOString(),
        known,
        knownUserName,
        sources: [...a.sources],
        statuses: a.statuses,
        lastPath: a.lastPath,
        lastUserAgent: a.lastUserAgent,
      };
    });
  }

  /** Synthèse chiffrée du trafic sur la fenêtre (cartes du tableau de bord). */
  async getSummary(
    opts: { windowDays?: number } = {},
    viewer: { isOwner?: boolean | null } = {},
  ): Promise<ApiTrafficSummaryDto> {
    const windowDays = Math.min(Math.max(opts.windowDays ?? 7, 1), 90);
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const base: Prisma.ApiTrafficLogWhereInput = { createdAt: { gte: since } };
    const ownerExcl = await this.ownerVis.nullableUserIdExclusion(viewer, 'userId');
    if (Object.keys(ownerExcl).length) base.AND = [ownerExcl as Prisma.ApiTrafficLogWhereInput];

    const [totalRequests, totalPartnerEvents, bySourceRows, byStatusRows, topPathRows, ipRows, knownFlagRows] =
      await Promise.all([
        this.prisma.apiTrafficLog.count({ where: { ...base, kind: 'REQUEST' } }),
        this.prisma.apiTrafficLog.count({ where: { ...base, kind: 'PARTNER_EVENT' } }),
        this.prisma.apiTrafficLog.groupBy({ by: ['source'], where: base, _count: { _all: true } }),
        this.prisma.apiTrafficLog.groupBy({ by: ['statusCode'], where: base, _count: { _all: true } }),
        this.prisma.apiTrafficLog.groupBy({
          by: ['path'],
          where: { ...base, path: { not: null } },
          _count: { _all: true },
          orderBy: { _count: { path: 'desc' } },
          take: 10,
        }),
        this.prisma.apiTrafficLog.groupBy({
          by: ['ip'],
          where: { ...base, ip: { not: null } },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
        this.prisma.apiTrafficLog.findMany({
          where: { ...base, ip: { not: null }, ipKnown: true },
          select: { ip: true },
          distinct: ['ip'],
          take: 10_000,
        }),
      ]);

    const bySource: Record<string, number> = {};
    for (const r of bySourceRows) bySource[r.source] = r._count._all;

    const byStatusClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    for (const r of byStatusRows) {
      const c = r.statusCode;
      if (c == null) continue;
      if (c >= 200 && c < 300) byStatusClass['2xx'] += r._count._all;
      else if (c >= 300 && c < 400) byStatusClass['3xx'] += r._count._all;
      else if (c >= 400 && c < 500) byStatusClass['4xx'] += r._count._all;
      else if (c >= 500 && c < 600) byStatusClass['5xx'] += r._count._all;
    }

    const topPaths = topPathRows
      .map((r) => ({ path: r.path ?? '', count: r._count._all }))
      .filter((p) => p.path);

    const knownSet = await this.loadKnownIps();
    const flagged = new Set(knownFlagRows.map((r) => r.ip).filter((x): x is string => !!x));
    const isKnown = (ip: string) => knownSet.has(ip) || flagged.has(ip);

    let knownIps = 0;
    let unknownIps = 0;
    const unknownList: { ip: string; count: number; lastSeen: string }[] = [];
    for (const r of ipRows) {
      const ip = r.ip;
      if (!ip) continue;
      if (isKnown(ip)) {
        knownIps++;
      } else {
        unknownIps++;
        unknownList.push({
          ip,
          count: r._count._all,
          lastSeen: (r._max.createdAt ?? since).toISOString(),
        });
      }
    }
    unknownList.sort((a, b) => b.count - a.count);

    return {
      windowDays,
      totalRequests,
      totalPartnerEvents,
      bySource,
      byStatusClass,
      uniqueIps: ipRows.length,
      unknownIps,
      knownIps,
      topPaths,
      topUnknownIps: unknownList.slice(0, 10),
    };
  }

  // ── Internes ───────────────────────────────────────────────────────────────

  /** Origine : override explicite valide, sinon déduite de l'Origin/Referer puis du path. */
  private resolveSource(input: ApiTrafficRecordInput): string {
    const explicit = (input.source ?? '').trim().toUpperCase();
    if (explicit && VALID_SOURCES.includes(explicit)) return explicit;

    const path = (input.path ?? '').toLowerCase();
    if (path.includes('/webhook')) return 'WEBHOOK';

    const host = (input.origin ?? '').toLowerCase();
    if (host.includes('maestroo')) return 'MAESTROO';
    if (host.includes('app-tracky') || host.includes('app.tracky')) return 'API';
    if (host.includes('tracky.vizyoagency.com')) return 'LP';

    if (path.startsWith('/api/leads')) return 'LP';
    return 'UNKNOWN';
  }

  /** Corpus des IP reconnues (leads LP + IP d'appels authentifiés), caché ~60 s. */
  private async loadKnownIps(): Promise<Set<string>> {
    const now = Date.now();
    if (this.knownIpsCache && now - this.knownIpsCache.at < this.knownTtlMs) {
      return this.knownIpsCache.set;
    }
    const since = new Date(now - this.knownWindowDays * 86_400_000);
    const set = new Set<string>();
    try {
      const [leads, authored] = await Promise.all([
        this.prisma.lead.findMany({
          where: { createdAt: { gte: since }, ipAddress: { not: null } },
          select: { ipAddress: true },
          distinct: ['ipAddress'],
          take: 5000,
        }),
        this.prisma.apiTrafficLog.findMany({
          where: { createdAt: { gte: since }, userId: { not: null }, ip: { not: null } },
          select: { ip: true },
          distinct: ['ip'],
          take: 5000,
        }),
      ]);
      for (const l of leads) if (l.ipAddress) set.add(l.ipAddress);
      for (const a of authored) if (a.ip) set.add(a.ip);
    } catch (e) {
      this.logger.warn(`loadKnownIps failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.knownIpsCache = { at: now, set };
    return set;
  }

  private async resolveUserNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(
      users.map((u) => [
        u.id,
        [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Utilisateur',
      ]),
    );
  }

  private async resolveLeadNames(ips: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ips)];
    if (!unique.length) return new Map();
    const since = new Date(Date.now() - this.knownWindowDays * 86_400_000);
    const leads = await this.prisma.lead.findMany({
      where: { ipAddress: { in: unique }, createdAt: { gte: since } },
      select: { ipAddress: true, name: true, company: true },
      orderBy: { createdAt: 'desc' },
    });
    const out = new Map<string, string>();
    for (const l of leads) {
      if (!l.ipAddress || out.has(l.ipAddress)) continue; // 1re rencontrée = plus récente
      const label = l.company || l.name;
      out.set(l.ipAddress, label ? `${label} (prospect LP)` : 'Prospect LP');
    }
    return out;
  }

  /** Filtre statut : classe '2xx'..'5xx' → intervalle, sinon code exact, sinon undefined. */
  private statusClassFilter(
    status?: string,
  ): number | { gte: number; lt: number } | undefined {
    if (!status) return undefined;
    const s = status.trim().toLowerCase();
    const ranges: Record<string, { gte: number; lt: number }> = {
      '2xx': { gte: 200, lt: 300 },
      '3xx': { gte: 300, lt: 400 },
      '4xx': { gte: 400, lt: 500 },
      '5xx': { gte: 500, lt: 600 },
    };
    if (ranges[s]) return ranges[s];
    const code = Number.parseInt(s, 10);
    return Number.isFinite(code) ? code : undefined;
  }

  private str(v: unknown, max: number): string {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  /** Métadonnées bornées : primitives seulement, clés courtes, ≤ 20 entrées. */
  private boundMeta(metaRaw: unknown, extra: Record<string, string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(extra)) if (v) out[k] = v;
    if (metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw)) {
      let n = 0;
      for (const [k, v] of Object.entries(metaRaw as Record<string, unknown>)) {
        if (n >= 20) break;
        if (k.length > 40) continue;
        if (typeof v === 'string') out[k] = v.slice(0, 200);
        else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
        else continue;
        n++;
      }
    }
    return out;
  }
}
