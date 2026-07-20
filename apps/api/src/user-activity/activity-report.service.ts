import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, type ActivityReport } from '@prisma/client';
import type {
  ActivityReportContent,
  ActivityReportDto,
  ActivityReportFrequency,
  ActivityReportListItemDto,
  ActivityReportOrigin,
  ActivityReportScheduleDto,
  ActivityReportScope,
  ActivityReportStatus,
  GenerateActivityReportDto,
  SetActivityReportScheduleDto,
} from '@vizyo/tracky-shared';
import { labelForRoute, ROUTE_LABELS } from '@vizyo/tracky-shared';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { AiRouter } from '../ai/ai-router.service';
import { AiFeatureFlagsService } from '../ai/ai-feature-flags.service';
import { OwnerVisibilityService } from '../common/owner-visibility.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { ACTIVITY_REPORT_SCHEMA, ACTIVITY_REPORT_SYSTEM } from './activity-report.prompt';

/** Auteur d'une génération : un super-admin (id) ou le système (null, cas planifié). */
type Actor = { id: string | null; fleetId: string | null };

const MAX_TARGETS = 20;
/** Cap de LIGNES du parcours envoyé à l'IA — appliqué APRÈS fusion des répétitions. */
const JOURNEY_CAP = 120;
/** Fenêtre d'events bruts lue en base avant fusion (biais RÉCENCE : les plus récents). */
const JOURNEY_RAW_FETCH = 800;
const FREQ_DAYS: Record<ActivityReportFrequency, number> = { daily: 1, weekly: 7, monthly: 30 };

/** Horodatages en fuseau EXPLICITE Europe/Paris (l'API tourne en Docker/UTC). */
const TS_DAY = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', month: '2-digit',
});
const TS_TIME = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit',
});

function fullName(u: { firstName?: string | null; lastName?: string | null }): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Utilisateur';
}
function clip(s: unknown, max: number): string {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}
function strList(v: unknown, cap: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, cap) : [];
}

/**
 * Palier 3 — Agent d'observation d'activité. Lit l'activité (sessions / pages / clics /
 * parcours) des utilisateurs ciblés sur une période, la fait analyser par Claude, et
 * PERSISTE un rapport structuré (conservé). Coût journalisé dans le tableau de bord Coûts IA
 * (action `activity_report`). Génération à la demande OU planifiée (cron + réglage singleton).
 */
@Injectable()
export class ActivityReportService {
  private readonly logger = new Logger(ActivityReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiRouter,
    private readonly aiUsage: AiUsageService,
    private readonly systemActivity: SystemActivityService,
    private readonly ownerVis: OwnerVisibilityService,
    private readonly featureFlags: AiFeatureFlagsService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /** Filtre Prisma masquant les rapports liés à un owner (créés-par OU ciblant) pour
   *  un viewer non-owner. `{}` si le viewer est owner ou s'il n'existe aucun owner. */
  private async ownerReportFilter(viewer: { isOwner?: boolean | null }): Promise<Prisma.ActivityReportWhereInput> {
    if (!this.ownerVis.isMasked(viewer)) return {};
    const ownerIds = await this.ownerVis.getOwnerIds();
    if (ownerIds.length === 0) return {};
    return {
      AND: [
        // createdByUserId NULLABLE : on conserve les rapports système (null) et on
        // n'exclut que ceux créés par un owner.
        { OR: [{ createdByUserId: null }, { createdByUserId: { notIn: ownerIds } }] },
        { NOT: { targetUserIds: { hasSome: ownerIds } } },
      ],
    };
  }

  /** true si ce rapport doit être masqué au viewer (non-owner + rapport créé-par/ciblant un owner). */
  private async isOwnerReportHidden(
    row: { createdByUserId: string | null; targetUserIds: string[] },
    viewer: { isOwner?: boolean | null },
  ): Promise<boolean> {
    if (!this.ownerVis.isMasked(viewer)) return false;
    const ownerIds = await this.ownerVis.getOwnerIds();
    if (ownerIds.length === 0) return false;
    const createdByOwner = !!row.createdByUserId && ownerIds.includes(row.createdByUserId);
    const targetsOwner = row.targetUserIds.some((t) => ownerIds.includes(t));
    return createdByOwner || targetsOwner;
  }

  // ─── Génération ────────────────────────────────────────────────────────────

  async generate(actor: Actor, dto: GenerateActivityReportDto, origin: ActivityReportOrigin = 'manual'): Promise<ActivityReportDto> {
    // Kill-switch GLOBAL (owner) : rapport d'activité IA coupé pour tout le monde.
    if (!(await this.featureFlags.isEnabled('activityReport'))) {
      throw new ForbiddenException('Le rapport d’activité IA est désactivé.');
    }
    let userIds = [...new Set((dto.userIds ?? []).filter((x) => typeof x === 'string'))].slice(0, MAX_TARGETS);
    // Owner plateforme — un acteur NON-owner ne peut pas générer de rapport ciblant
    // un owner (défense en profondeur : l'owner n'apparaît déjà pas dans le picker).
    const ownerIds = await this.ownerVis.getOwnerIds();
    const actorIsOwner = !!actor.id && ownerIds.includes(actor.id);
    if (!actorIsOwner && ownerIds.length) {
      userIds = userIds.filter((id) => !ownerIds.includes(id));
    }
    if (userIds.length === 0) throw new BadRequestException('Sélectionnez au moins un utilisateur.');
    const to = dto.to ? new Date(dto.to) : new Date();
    const from = dto.from ? new Date(dto.from) : new Date(to.getTime() - 7 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to.getTime() <= from.getTime()) {
      throw new BadRequestException('Période invalide.');
    }

    const payload = await this.buildPayload(userIds, from, to);
    // Erreurs comprises : un utilisateur qui n'a QUE des erreurs mérite un rapport.
    const totalEvents = payload.users.reduce((s, u) => s + u.totalEvents + u.errorCount, 0);
    const title = this.deriveTitle(payload.users.map((u) => u.name), from, to);

    // Aucune activité → rapport « vide » sans appel IA (économise le coût).
    if (totalEvents === 0) {
      const content: ActivityReportContent = {
        summary: 'Aucune activité enregistrée pour cette sélection sur la période.',
        journey: '—',
        frictionPoints: [],
        adoption: { used: [], ignored: [] },
        recommendations: [],
      };
      const row = await this.prisma.activityReport.create({
        data: { createdByUserId: actor.id, targetUserIds: userIds, fromAt: from, toAt: to, status: 'READY', origin, title, content: content as unknown as Prisma.InputJsonValue, costUsd: 0 },
      });
      return this.toDto(row);
    }

    try {
      const call = await this.ai.completeJson<ActivityReportContent>({
        system: ACTIVITY_REPORT_SYSTEM,
        userPayload: payload,
        schema: ACTIVITY_REPORT_SCHEMA,
        // 16000 (parité optimiseur) : un rapport large (8-12 users / longue période) avec
        // thinking adaptatif dépassait 4096 → JSON tronqué → échec. Plafond only (sans coût
        // supplémentaire pour les rapports qui tenaient déjà).
        maxTokens: 16000,
      });
      const content = this.sanitize(call.result);
      const costUsd = this.aiUsage.costOf(call.model, call.usage);
      void this.aiUsage.record({
        userId: actor.id, fleetId: actor.fleetId, action: 'activity_report', model: call.model,
        inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
        cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
        latencyMs: call.latencyMs, ok: true,
      });
      const row = await this.prisma.activityReport.create({
        data: { createdByUserId: actor.id, targetUserIds: userIds, fromAt: from, toAt: to, status: 'READY', origin, title, content: content as unknown as Prisma.InputJsonValue, model: call.model, costUsd },
      });
      return this.toDto(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Rapport d'activité en échec : ${message}`);
      // On PERSISTE l'échec (visible dans l'historique) plutôt que de le perdre.
      const row = await this.prisma.activityReport.create({
        data: { createdByUserId: actor.id, targetUserIds: userIds, fromAt: from, toAt: to, status: 'FAILED', origin, title, error: message.slice(0, 400), costUsd: 0 },
      });
      return this.toDto(row);
    }
  }

  // ─── Lecture ───────────────────────────────────────────────────────────────

  async list(limit = 30, viewer: { isOwner?: boolean | null } = {}): Promise<ActivityReportListItemDto[]> {
    const take = Math.min(Math.max(limit, 1), 100);
    const where = await this.ownerReportFilter(viewer);
    const rows = await this.prisma.activityReport.findMany({ where, orderBy: { createdAt: 'desc' }, take });
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      title: r.title,
      status: r.status as ActivityReportStatus,
      origin: r.origin as ActivityReportOrigin,
      targetCount: r.targetUserIds.length,
      from: r.fromAt.toISOString(),
      to: r.toAt.toISOString(),
    }));
  }

  async get(id: string, viewer: { isOwner?: boolean | null } = {}): Promise<ActivityReportDto> {
    const row = await this.prisma.activityReport.findUnique({ where: { id } });
    // Rapport lié à un owner → même 404 qu'un id inexistant pour un viewer non-owner.
    if (!row || (await this.isOwnerReportHidden(row, viewer))) throw new NotFoundException('Rapport introuvable.');
    return this.toDto(row);
  }

  /** Supprime un rapport (essais, échecs accumulés) — l'historique est capé à 100. */
  async delete(id: string, viewer: { isOwner?: boolean | null } = {}): Promise<{ ok: true }> {
    const row = await this.prisma.activityReport.findUnique({
      where: { id },
      select: { id: true, createdByUserId: true, targetUserIds: true },
    });
    if (!row || (await this.isOwnerReportHidden(row, viewer))) throw new NotFoundException('Rapport introuvable.');
    await this.prisma.activityReport.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Planification (singleton) ───────────────────────────────────────────────

  async getSchedule(): Promise<ActivityReportScheduleDto> {
    const row = await this.prisma.activityReportSchedule.findFirst({ orderBy: { updatedAt: 'desc' } });
    return {
      enabled: row?.enabled ?? false,
      frequency: (row?.frequency as ActivityReportFrequency) ?? 'weekly',
      scope: (row?.scope as ActivityReportScope) ?? 'ACTIVE',
      lastRunAt: row?.lastRunAt?.toISOString() ?? null,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  async setSchedule(dto: SetActivityReportScheduleDto, userId?: string): Promise<ActivityReportScheduleDto> {
    const existing = await this.prisma.activityReportSchedule.findFirst();
    const data = { enabled: dto.enabled, frequency: dto.frequency, scope: dto.scope, updatedByUserId: userId ?? null };
    if (existing) await this.prisma.activityReportSchedule.update({ where: { id: existing.id }, data });
    else await this.prisma.activityReportSchedule.create({ data });
    return this.getSchedule();
  }

  /** Filet de génération planifiée : tourne chaque heure, agit seulement si due. */
  @Cron('0 20 * * * *')
  async runScheduled(): Promise<void> {
    try {
      const row = await this.prisma.activityReportSchedule.findFirst({ orderBy: { updatedAt: 'desc' } });
      if (!row?.enabled) return;
      const periodDays = FREQ_DAYS[(row.frequency as ActivityReportFrequency)] ?? 7;
      const dueMs = periodDays * 86_400_000;
      if (row.lastRunAt && Date.now() - row.lastRunAt.getTime() < dueMs) return;

      const to = new Date();
      const from = new Date(to.getTime() - dueMs);
      const userIds = await this.pickScheduledUsers(row.scope as ActivityReportScope, from, to);
      if (userIds.length > 0) {
        const report = await this.generate({ id: null, fleetId: null }, { userIds, from: from.toISOString(), to: to.toISOString() }, 'scheduled');
        // Palier B — trace la génération PLANIFIÉE (action IA en arrière-plan). La génération
        // manuelle (super-admin) est une action front, pas journalisée ici.
        this.systemActivity.record({
          category: 'AI_REPORT',
          action: 'activity_report_generated',
          status: report.status === 'FAILED' ? 'FAILURE' : 'SUCCESS',
          actor: 'planning',
          target: report.title ?? `${userIds.length} utilisateur(s)`,
          detail: `Rapport IA ${row.frequency} — ${userIds.length} utilisateur(s) observé(s)`,
          meta: { reportId: report.id, frequency: row.frequency, scope: row.scope, costUsd: report.costUsd },
        });
      }
      await this.prisma.activityReportSchedule.update({ where: { id: row.id }, data: { lastRunAt: to } });
    } catch (e) {
      this.logger.error('runScheduled failed', e as Error);
      this.errorLogger.recordBackground(e instanceof Error ? e : new Error(String(e)), 'cron:activity-report');
    }
  }

  private async pickScheduledUsers(scope: ActivityReportScope, from: Date, to: Date): Promise<string[]> {
    // Owner plateforme — jamais inclus dans une génération PLANIFIÉE (système).
    if (scope === 'ALL') {
      const users = await this.prisma.user.findMany({ where: { isOwner: false }, select: { id: true }, take: MAX_TARGETS });
      return users.map((u) => u.id);
    }
    const sessions = await this.prisma.userSession.findMany({
      where: { startedAt: { gte: from, lte: to }, user: { isOwner: false } },
      select: { userId: true },
      distinct: ['userId'],
      take: MAX_TARGETS,
    });
    return sessions.map((s) => s.userId);
  }

  // ─── Payload d'activité (borné) ──────────────────────────────────────────────

  /** Écrans accessibles selon le rôle — ancre l'analyse d'adoption sur le RÉEL. */
  private accessibleFeatures(role: string): string[] {
    if (role === 'NIGHT_WATCHMAN') return ['Véhicules', 'Mon compte'];
    const labels = Object.entries(ROUTE_LABELS)
      .filter(([k]) => k !== '/login')
      .filter(([k]) => role === 'SUPER_ADMIN' || !k.startsWith('/admin'))
      .map(([, v]) => v);
    return [...new Set(labels)];
  }

  private async buildPayload(userIds: string[], from: Date, to: Date) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, role: true },
    });
    const inWindow = { gte: from, lte: to };
    const perUser = [];
    for (const u of users) {
      const [sessionCount, pv, clicks, forms, endReasonsRaw, devicesRaw, scrollRaw, totalEvents, errorCount, errorRows, journeyRaw] =
        await Promise.all([
          this.prisma.userSession.count({ where: { userId: u.id, startedAt: inWindow } }),
          this.prisma.userActivity.groupBy({
            by: ['route'],
            where: { userId: u.id, type: 'PAGE_VIEW', route: { not: null }, createdAt: inWindow },
            _count: { _all: true },
            _sum: { durationMs: true },
            orderBy: { _count: { route: 'desc' } },
            take: 15,
          }),
          this.prisma.userActivity.groupBy({
            by: ['target'],
            where: { userId: u.id, type: 'CLICK', target: { not: null }, createdAt: inWindow },
            _count: { _all: true },
            orderBy: { _count: { target: 'desc' } },
            take: 20,
          }),
          // Formulaires SOUMIS = action menée à son terme (meilleur signal d'adoption réelle).
          this.prisma.userActivity.groupBy({
            by: ['target'],
            where: { userId: u.id, type: 'FORM_SUBMIT', target: { not: null }, createdAt: inWindow },
            _count: { _all: true },
            orderBy: { _count: { target: 'desc' } },
            take: 10,
          }),
          // Répartition COMPLÈTE des fins de session (le parcours n'est qu'un échantillon).
          this.prisma.userActivity.groupBy({
            by: ['target'],
            where: { userId: u.id, type: 'SESSION_END', createdAt: inWindow },
            _count: { _all: true },
          }),
          this.prisma.userSession.groupBy({
            by: ['deviceType'],
            where: { userId: u.id, startedAt: inWindow },
            _count: { _all: true },
          }),
          // Profondeur de scroll par page — groupBy (route, '<pct>%') compresse naturellement.
          this.prisma.userActivity.groupBy({
            by: ['route', 'target'],
            where: { userId: u.id, type: 'SCROLL', route: { not: null }, createdAt: inWindow },
            _count: { _all: true },
          }),
          // VRAI volume (non plafonné) — le parcours est un échantillon, pas le total.
          this.prisma.userActivity.count({
            where: { userId: u.id, type: { in: ['PAGE_VIEW', 'CLICK', 'FORM_SUBMIT', 'SESSION_START', 'SESSION_END'] }, createdAt: inWindow },
          }),
          // Erreurs RÉELLEMENT subies (front + 5xx serveur) = frictions avérées.
          this.prisma.errorLog.count({
            where: { userId: u.id, createdAt: inWindow, source: { in: ['frontend', 'http'] } },
          }),
          this.prisma.errorLog.findMany({
            where: { userId: u.id, createdAt: inWindow, source: { in: ['frontend', 'http'] } },
            orderBy: { createdAt: 'desc' },
            take: 30,
            select: { source: true, level: true, message: true, createdAt: true, context: true },
          }),
          // Parcours brut, biais RÉCENCE (les derniers events), fusionné/sessionné ensuite.
          this.prisma.userActivity.findMany({
            where: { userId: u.id, type: { in: ['PAGE_VIEW', 'CLICK', 'FORM_SUBMIT', 'SESSION_END'] }, createdAt: inWindow },
            orderBy: { createdAt: 'desc' },
            take: JOURNEY_RAW_FETCH,
            select: { type: true, route: true, routeLabel: true, target: true, durationMs: true, createdAt: true, sessionId: true },
          }),
        ]);

      const { journey, truncated: journeyTruncated } = await this.compressJourney(journeyRaw.reverse());

      const endReasons: Record<string, number> = {};
      for (const r of endReasonsRaw) endReasons[r.target ?? 'auto'] = r._count._all;
      const devices: Record<string, number> = {};
      for (const d of devicesRaw) devices[d.deviceType ?? 'unknown'] = (devices[d.deviceType ?? 'unknown'] ?? 0) + d._count._all;

      perUser.push({
        name: fullName(u),
        role: u.role,
        accessibleFeatures: this.accessibleFeatures(u.role),
        sessionCount,
        devices,
        endReasons,
        pages: pv.map((p) => ({
          route: p.route,
          label: p.route ? labelForRoute(p.route) : null,
          views: p._count._all,
          totalSec: Math.round((p._sum.durationMs ?? 0) / 1000),
        })),
        topClicks: clicks.map((c) => ({ target: c.target, count: c._count._all })),
        formSubmits: forms.map((f) => ({ target: f.target, count: f._count._all })),
        scrollDepth: this.aggregateScroll(scrollRaw),
        errorCount,
        errors: errorRows.map((e) => {
          const ctx = (e.context ?? {}) as Record<string, unknown>;
          return {
            at: e.createdAt.toISOString(),
            source: e.source,
            level: e.level,
            message: clip(e.message, 200),
            route: (typeof ctx['page'] === 'string' ? ctx['page'] : typeof ctx['route'] === 'string' ? ctx['route'] : null) as string | null,
            httpStatus: (typeof ctx['httpStatus'] === 'number' ? ctx['httpStatus'] : typeof ctx['statusCode'] === 'number' ? ctx['statusCode'] : null) as number | null,
          };
        }),
        journey,
        totalEvents,
        journeySampled: journeyTruncated,
        journeyNote: journeyTruncated
          ? `parcours = échantillon des événements les plus RÉCENTS (${journey.length} lignes) sur ${totalEvents} au total`
          : undefined,
      });
    }
    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      timeZone: 'Europe/Paris',
      users: perUser,
    };
  }

  /** Agrège les SCROLL (route, 'NN%') → profondeur max + médiane pondérée par page. */
  private aggregateScroll(
    rows: Array<{ route: string | null; target: string | null; _count: { _all: number } }>,
  ): Array<{ page: string; maxPct: number; medianPct: number; samples: number }> {
    const byRoute = new Map<string, { pcts: Array<{ pct: number; n: number }>; samples: number }>();
    for (const r of rows) {
      const pct = parseInt(r.target ?? '', 10);
      if (!r.route || Number.isNaN(pct)) continue;
      const key = labelForRoute(r.route);
      const cur = byRoute.get(key) ?? { pcts: [], samples: 0 };
      cur.pcts.push({ pct, n: r._count._all });
      cur.samples += r._count._all;
      byRoute.set(key, cur);
    }
    return [...byRoute.entries()]
      .sort((a, b) => b[1].samples - a[1].samples)
      .slice(0, 8)
      .map(([page, v]) => {
        const sorted = v.pcts.sort((a, b) => a.pct - b.pct);
        const half = v.samples / 2;
        let acc = 0;
        let median = 0;
        for (const p of sorted) {
          acc += p.n;
          if (acc >= half) { median = p.pct; break; }
        }
        return { page, maxPct: sorted[sorted.length - 1]?.pct ?? 0, medianPct: median, samples: v.samples };
      });
  }

  /**
   * Compresse le parcours brut : fusion des répétitions CONSÉCUTIVES (page ×N avec durée
   * cumulée, clics ×N — les alternances A→B→A restent distinctes, c'est du signal),
   * séparateurs de session horodatés (jour + device), cap aux JOURNEY_CAP dernières lignes.
   */
  private async compressJourney(
    raw: Array<{ type: string; route: string | null; routeLabel: string | null; target: string | null; durationMs: number | null; createdAt: Date; sessionId: string | null }>,
  ): Promise<{ journey: string[]; sampleSize: number; truncated: boolean }> {
    if (raw.length === 0) return { journey: [], sampleSize: 0, truncated: false };

    const sessionIds = [...new Set(raw.map((r) => r.sessionId).filter((x): x is string => !!x))];
    const sessions = sessionIds.length
      ? await this.prisma.userSession.findMany({
          where: { id: { in: sessionIds } },
          select: { id: true, startedAt: true, deviceType: true },
        })
      : [];
    const sessMeta = new Map(sessions.map((s) => [s.id, s]));

    const lines: string[] = [];
    let cur: { key: string; type: string; label: string; count: number; durMs: number; at: Date } | null = null;
    let curSession: string | null | undefined;

    const flush = () => {
      if (!cur) return;
      const time = TS_TIME.format(cur.at);
      const sec = Math.round(cur.durMs / 1000);
      if (cur.type === 'PAGE_VIEW') {
        const extra = cur.count > 1
          ? ` (×${cur.count}${sec ? `, ${sec}s actif cumulés` : ''})`
          : sec ? ` (${sec}s actif)` : '';
        lines.push(`${time} · page:${cur.label}${extra}`);
      } else if (cur.type === 'CLICK') {
        lines.push(`${time} · clic:${cur.label}${cur.count > 1 ? ` (×${cur.count})` : ''}`);
      } else if (cur.type === 'FORM_SUBMIT') {
        lines.push(`${time} · envoi:${cur.label}`);
      } else if (cur.type === 'SESSION_END') {
        lines.push(`${time} · session:fin (${cur.label})`);
      }
      cur = null;
    };

    for (const j of raw) {
      if (j.sessionId !== curSession) {
        flush();
        curSession = j.sessionId;
        const m = j.sessionId ? sessMeta.get(j.sessionId) : undefined;
        const start = m?.startedAt ?? j.createdAt;
        lines.push(`— session du ${TS_DAY.format(start)} ${TS_TIME.format(start)}${m?.deviceType ? ` (${m.deviceType})` : ''} —`);
      }
      const label =
        j.type === 'PAGE_VIEW'
          ? (j.routeLabel ?? (j.route ? labelForRoute(j.route) : '?'))
          : j.type === 'SESSION_END'
            ? (j.target ?? 'auto')
            : (j.target ?? '?');
      const key = `${j.type}|${label}`;
      if (cur && cur.key === key && (j.type === 'PAGE_VIEW' || j.type === 'CLICK')) {
        cur.count++;
        cur.durMs += j.durationMs ?? 0;
      } else {
        flush();
        cur = { key, type: j.type, label, count: 1, durMs: j.durationMs ?? 0, at: j.createdAt };
      }
    }
    flush();

    // « Tronqué » = on a atteint le plafond de fetch (des events plus anciens
    // existent) OU la compression a dépassé JOURNEY_CAP lignes (slice ci-dessous).
    const truncated = raw.length >= JOURNEY_RAW_FETCH || lines.length > JOURNEY_CAP;
    return { journey: lines.slice(-JOURNEY_CAP), sampleSize: raw.length, truncated };
  }

  // ─── Mapping ─────────────────────────────────────────────────────────────────

  private sanitize(c: Partial<ActivityReportContent> | null | undefined): ActivityReportContent {
    const fp = Array.isArray(c?.frictionPoints) ? c!.frictionPoints : [];
    const rec = Array.isArray(c?.recommendations) ? c!.recommendations : [];
    const per = Array.isArray(c?.perUser)
      ? c!.perUser
          .slice(0, MAX_TARGETS)
          .map((p) => ({
            name: clip(p?.name, 120),
            highlight: clip(p?.highlight, 400),
            mainFriction: clip(p?.mainFriction, 300) || undefined,
          }))
          .filter((p) => p.name && p.highlight)
      : undefined;
    return {
      summary: clip(c?.summary, 1500),
      journey: clip(c?.journey, 3000),
      frictionPoints: fp.slice(0, 15).map((f) => ({ title: clip(f?.title, 120), detail: clip(f?.detail, 600), severity: clip(f?.severity, 10) || undefined })),
      adoption: { used: strList(c?.adoption?.used, 30), ignored: strList(c?.adoption?.ignored, 30), note: clip(c?.adoption?.note, 600) || undefined },
      recommendations: rec.slice(0, 15).map((r) => ({ title: clip(r?.title, 120), detail: clip(r?.detail, 600), impact: clip(r?.impact, 30) || undefined })),
      perUser: per && per.length > 0 ? per : undefined,
    };
  }

  private deriveTitle(names: string[], from: Date, to: Date): string {
    const who = names.length === 0 ? 'Aucun' : names.length === 1 ? names[0] : `${names.length} utilisateurs`;
    const d = (x: Date) => x.toISOString().slice(0, 10);
    return `${who} — ${d(from)} → ${d(to)}`;
  }

  private async toDto(row: ActivityReport): Promise<ActivityReportDto> {
    const ids = [...new Set([...(row.targetUserIds ?? []), ...(row.createdByUserId ? [row.createdByUserId] : [])])];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const nameById = new Map(users.map((u) => [u.id, fullName(u)]));
    const rate = this.aiUsage.eurRate();
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      createdByName: row.createdByUserId ? (nameById.get(row.createdByUserId) ?? null) : null,
      targets: (row.targetUserIds ?? []).map((id) => ({ userId: id, name: nameById.get(id) ?? null })),
      from: row.fromAt.toISOString(),
      to: row.toAt.toISOString(),
      status: row.status as ActivityReportStatus,
      origin: row.origin as ActivityReportOrigin,
      title: row.title,
      content: (row.content as ActivityReportContent | null) ?? null,
      error: row.error,
      costUsd: row.costUsd,
      costEur: row.costUsd * rate,
    };
  }
}
