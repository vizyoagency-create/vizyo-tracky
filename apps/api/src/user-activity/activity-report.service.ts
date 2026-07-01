import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { AnthropicClient } from '../ai/anthropic.client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { ACTIVITY_REPORT_SCHEMA, ACTIVITY_REPORT_SYSTEM } from './activity-report.prompt';

/** Auteur d'une génération : un super-admin (id) ou le système (null, cas planifié). */
type Actor = { id: string | null; fleetId: string | null };

const MAX_TARGETS = 20;
const JOURNEY_CAP = 120;
const FREQ_DAYS: Record<ActivityReportFrequency, number> = { daily: 1, weekly: 7, monthly: 30 };

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
    private readonly anthropic: AnthropicClient,
    private readonly aiUsage: AiUsageService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  // ─── Génération ────────────────────────────────────────────────────────────

  async generate(actor: Actor, dto: GenerateActivityReportDto, origin: ActivityReportOrigin = 'manual'): Promise<ActivityReportDto> {
    const userIds = [...new Set((dto.userIds ?? []).filter((x) => typeof x === 'string'))].slice(0, MAX_TARGETS);
    if (userIds.length === 0) throw new BadRequestException('Sélectionnez au moins un utilisateur.');
    const to = dto.to ? new Date(dto.to) : new Date();
    const from = dto.from ? new Date(dto.from) : new Date(to.getTime() - 7 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to.getTime() <= from.getTime()) {
      throw new BadRequestException('Période invalide.');
    }

    const payload = await this.buildPayload(userIds, from, to);
    const totalEvents = payload.users.reduce((s, u) => s + u.totalEvents, 0);
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
      const call = await this.anthropic.completeJson<ActivityReportContent>({
        system: ACTIVITY_REPORT_SYSTEM,
        userPayload: payload,
        schema: ACTIVITY_REPORT_SCHEMA,
        maxTokens: 4096,
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

  async list(limit = 30): Promise<ActivityReportListItemDto[]> {
    const take = Math.min(Math.max(limit, 1), 100);
    const rows = await this.prisma.activityReport.findMany({ orderBy: { createdAt: 'desc' }, take });
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

  async get(id: string): Promise<ActivityReportDto> {
    const row = await this.prisma.activityReport.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Rapport introuvable.');
    return this.toDto(row);
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
    }
  }

  private async pickScheduledUsers(scope: ActivityReportScope, from: Date, to: Date): Promise<string[]> {
    if (scope === 'ALL') {
      const users = await this.prisma.user.findMany({ select: { id: true }, take: MAX_TARGETS });
      return users.map((u) => u.id);
    }
    const sessions = await this.prisma.userSession.findMany({
      where: { startedAt: { gte: from, lte: to } },
      select: { userId: true },
      distinct: ['userId'],
      take: MAX_TARGETS,
    });
    return sessions.map((s) => s.userId);
  }

  // ─── Payload d'activité (borné) ──────────────────────────────────────────────

  private async buildPayload(userIds: string[], from: Date, to: Date) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true, role: true },
    });
    const perUser = [];
    for (const u of users) {
      const [sessionCount, pv, clicks, journey] = await Promise.all([
        this.prisma.userSession.count({ where: { userId: u.id, startedAt: { gte: from, lte: to } } }),
        this.prisma.userActivity.groupBy({
          by: ['route'],
          where: { userId: u.id, type: 'PAGE_VIEW', route: { not: null }, createdAt: { gte: from, lte: to } },
          _count: { _all: true },
          _sum: { durationMs: true },
          orderBy: { _count: { route: 'desc' } },
          take: 15,
        }),
        this.prisma.userActivity.groupBy({
          by: ['target'],
          where: { userId: u.id, type: 'CLICK', target: { not: null }, createdAt: { gte: from, lte: to } },
          _count: { _all: true },
          orderBy: { _count: { target: 'desc' } },
          take: 20,
        }),
        this.prisma.userActivity.findMany({
          where: { userId: u.id, type: { in: ['PAGE_VIEW', 'CLICK', 'SESSION_START', 'SESSION_END'] }, createdAt: { gte: from, lte: to } },
          orderBy: { createdAt: 'asc' },
          take: JOURNEY_CAP,
          select: { type: true, route: true, routeLabel: true, target: true, durationMs: true },
        }),
      ]);
      perUser.push({
        name: fullName(u),
        role: u.role,
        sessionCount,
        pages: pv.map((p) => ({ route: p.route, views: p._count._all, totalSec: Math.round((p._sum.durationMs ?? 0) / 1000) })),
        topClicks: clicks.map((c) => ({ target: c.target, count: c._count._all })),
        journey: journey.map((j) => {
          if (j.type === 'PAGE_VIEW') return `page:${j.routeLabel ?? j.route ?? '?'}${j.durationMs ? ` (${Math.round(j.durationMs / 1000)}s actif)` : ''}`;
          if (j.type === 'CLICK') return `clic:${j.target ?? '?'}`;
          if (j.type === 'SESSION_START') return 'session:début';
          if (j.type === 'SESSION_END') return `session:fin (${j.target ?? 'auto'})`;
          return j.type;
        }),
        totalEvents: journey.length,
      });
    }
    return { period: { from: from.toISOString(), to: to.toISOString() }, users: perUser };
  }

  // ─── Mapping ─────────────────────────────────────────────────────────────────

  private sanitize(c: Partial<ActivityReportContent> | null | undefined): ActivityReportContent {
    const fp = Array.isArray(c?.frictionPoints) ? c!.frictionPoints : [];
    const rec = Array.isArray(c?.recommendations) ? c!.recommendations : [];
    return {
      summary: clip(c?.summary, 1500),
      journey: clip(c?.journey, 3000),
      frictionPoints: fp.slice(0, 15).map((f) => ({ title: clip(f?.title, 120), detail: clip(f?.detail, 600), severity: clip(f?.severity, 10) || undefined })),
      adoption: { used: strList(c?.adoption?.used, 30), ignored: strList(c?.adoption?.ignored, 30), note: clip(c?.adoption?.note, 600) || undefined },
      recommendations: rec.slice(0, 15).map((r) => ({ title: clip(r?.title, 120), detail: clip(r?.detail, 600), impact: clip(r?.impact, 30) || undefined })),
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
