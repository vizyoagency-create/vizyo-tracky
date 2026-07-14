import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AiBudgetStatus,
  AiUsageBreakdownRowDto,
  AiUsageBudgetDto,
  AiUsageLogsPageDto,
  AiUsageSummaryDto,
} from '@vizyo/tracky-shared';
import { OwnerVisibilityService } from '../common/owner-visibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

/** Tarifs Anthropic en USD / 1M tokens (figés côté serveur ; source de vérité du coût). */
interface Pricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
const PRICING: Record<string, Pricing> = {
  // Anthropic — Opus 4.8 : input 5 $, output 25 $ ; cache write (5 min) 1,25× ; cache read 0,1×.
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  // OpenAI (couche multi-provider 2026-07) — tarifs / 1M tokens. cacheWrite=0 (OpenAI ne facture
  // pas l'écriture de cache) ; cacheRead = tarif « cached input ». Clés = préfixe de modèle (le
  // provider renvoie une version datée, ex. `gpt-4.1-2025-04-14` → résolu par préfixe, cf. resolvePricing).
  'gpt-4.1': { input: 2, output: 8, cacheWrite: 0, cacheRead: 0.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheWrite: 0, cacheRead: 0.1 },
  'gpt-4o': { input: 2.5, output: 10, cacheWrite: 0, cacheRead: 1.25 },
};
const FALLBACK_PRICING: Pricing = PRICING['claude-opus-4-8'];

/**
 * Résout la grille tarifaire d'un modèle. Les providers renvoient souvent une version DATÉE
 * (`gpt-4.1-2025-04-14`, `claude-opus-4-8-20260101`…) : on tente l'exact, puis le plus long
 * PRÉFIXE connu. Repli = Opus (le plus cher) pour ne jamais SOUS-estimer un coût inconnu.
 */
function resolvePricing(model: string): Pricing {
  if (PRICING[model]) return PRICING[model];
  let best: { key: string; p: Pricing } | null = null;
  for (const [key, p] of Object.entries(PRICING)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) best = { key, p };
  }
  return best?.p ?? FALLBACK_PRICING;
}

const ACTION_LABELS: Record<string, string> = {
  capacity: 'Capacité',
  placement: 'Placement',
  agenda_optimization: 'Agenda (agent)',
  agenda_agent: 'Agent agenda',
  activity_report: "Rapport d'activité",
  trip_analysis: 'Analyse de trajet',
  booking_parse: 'Réservation (vocal)',
};

export interface AiUsageEntry {
  userId?: string | null;
  fleetId?: string | null;
  model: string;
  action: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  latencyMs?: number | null;
  ok?: boolean;
}

/**
 * Palier « Coûts IA » — enregistre chaque appel Claude réussi (tokens + coût estimé) et
 * fournit les agrégats du tableau de bord super-admin + le budget mensuel. Le calcul de coût
 * vit ici (source unique). L'enregistrement est NON BLOQUANT : jamais d'exception propagée.
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemActivity: SystemActivityService,
    private readonly ownerVis: OwnerVisibilityService,
  ) {}

  /** Taux USD→€ (env `AI_USD_TO_EUR`, défaut 0,92). */
  private usdToEur(): number {
    const r = Number(process.env.AI_USD_TO_EUR);
    return Number.isFinite(r) && r > 0 ? r : 0.92;
  }

  private computeCostUsd(model: string, input: number, output: number, cacheWrite: number, cacheRead: number): number {
    const p = resolvePricing(model);
    return (input * p.input + output * p.output + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead) / 1_000_000;
  }

  /** Coût USD d'un usage donné (réutilisé pour stocker le coût ailleurs, ex. rapport d'activité). */
  costOf(model: string, usage: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }): number {
    return this.computeCostUsd(model, usage.inputTokens, usage.outputTokens, usage.cacheWriteTokens, usage.cacheReadTokens);
  }

  /** Taux USD→€ appliqué (exposé pour convertir des coûts stockés ailleurs). */
  eurRate(): number {
    return this.usdToEur();
  }

  /** Journalise un appel IA. Ne lève jamais (le coût ne doit pas casser la requête métier). */
  async record(entry: AiUsageEntry): Promise<void> {
    try {
      const i = Math.max(0, entry.inputTokens | 0);
      const o = Math.max(0, entry.outputTokens | 0);
      const cw = Math.max(0, entry.cacheWriteTokens | 0);
      const cr = Math.max(0, entry.cacheReadTokens | 0);
      const costUsd = this.computeCostUsd(entry.model, i, o, cw, cr);
      await this.prisma.aiUsageLog.create({
        data: {
          userId: entry.userId ?? null,
          fleetId: entry.fleetId ?? null,
          model: entry.model,
          action: entry.action,
          inputTokens: i,
          outputTokens: o,
          cacheWriteTokens: cw,
          cacheReadTokens: cr,
          costUsd,
          latencyMs: entry.latencyMs ?? null,
          ok: entry.ok ?? true,
        },
      });
      // Funnel unique des appels IA → visible aussi dans l'onglet Système. On skippe
      // 'activity_report' (le planifié est déjà journalisé en AI_REPORT ; le manuel
      // est un acte utilisateur couvert par l'audit MUTATION).
      if (entry.action !== 'activity_report') {
        this.systemActivity.record({
          category: 'AI',
          action: `ai_${entry.action}`,
          status: entry.ok === false ? 'FAILURE' : 'SUCCESS',
          actor: entry.userId ? 'utilisateur' : 'system',
          detail: `${ACTION_LABELS[entry.action] ?? entry.action} · ${entry.model}`,
          fleetId: entry.fleetId ?? null,
          triggeredByUserId: entry.userId ?? null,
          durationMs: entry.latencyMs ?? null,
          meta: { costUsd, model: entry.model },
        });
      }
    } catch (e) {
      this.logger.warn(`AiUsageLog non journalisé : ${(e as Error)?.message ?? e}`);
    }
  }

  // ─── Tableau de bord ───────────────────────────────────────────────────────

  async summary(
    fromIso?: string,
    toIso?: string,
    scopeFleetId?: string,
    viewer: { isOwner?: boolean | null } = {},
  ): Promise<AiUsageSummaryDto> {
    const rate = this.usdToEur();
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    // scopeFleetId : un FLEET_ADMIN ne voit QUE sa société (forcé par le controller) ; un
    // SUPER_ADMIN filtre librement (undefined = toutes). ET owner plateforme : exclu de TOUS les
    // agrégats pour un viewer non-owner (total inclus, sinon le delta total − Σ(par user) trahirait
    // une dépense masquée). userId NULLABLE (appels système) → on conserve les null, on exclut les owners.
    const ownerIds = this.ownerVis.isMasked(viewer) ? await this.ownerVis.getOwnerIds() : [];
    const where: Prisma.AiUsageLogWhereInput = {
      createdAt: { gte: from, lte: to },
      ...(scopeFleetId ? { fleetId: scopeFleetId } : {}),
    };
    if (ownerIds.length) where.OR = [{ userId: null }, { userId: { notIn: ownerIds } }];
    const fleetCond = scopeFleetId ? Prisma.sql`AND "fleetId" = ${scopeFleetId}::uuid` : Prisma.empty;
    const notOwnerAi = ownerIds.length
      ? Prisma.sql`AND ("userId" IS NULL OR "userId" <> ALL(${ownerIds}::uuid[]))`
      : Prisma.empty;

    const [agg, byActionRaw, byFleetRaw, byUserRaw, dayRows] = await Promise.all([
      this.prisma.aiUsageLog.aggregate({
        where,
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, costUsd: true },
      }),
      this.prisma.aiUsageLog.groupBy({ by: ['action'], where, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true } }),
      this.prisma.aiUsageLog.groupBy({ by: ['fleetId'], where, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true } }),
      this.prisma.aiUsageLog.groupBy({ by: ['userId'], where, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, costUsd: true } }),
      this.prisma.$queryRaw<Array<{ day: Date; calls: bigint; cost: number }>>`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS calls, COALESCE(SUM("costUsd"), 0) AS cost
        FROM ai_usage_logs
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to} ${fleetCond} ${notOwnerAi}
        GROUP BY 1 ORDER BY 1 ASC`,
    ]);

    const fleetIds = byFleetRaw.map((r) => r.fleetId).filter((x): x is string => !!x);
    const userIds = byUserRaw.map((r) => r.userId).filter((x): x is string => !!x);
    const [fleets, users] = await Promise.all([
      fleetIds.length ? this.prisma.fleet.findMany({ where: { id: { in: fleetIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [],
    ]);
    const fleetName = new Map(fleets.map((f) => [f.id, f.name]));
    const userEmail = new Map(users.map((u) => [u.id, u.email]));

    const row = (key: string | null, label: string, calls: number, i: number, o: number, cost: number): AiUsageBreakdownRowDto => ({
      key: key ?? '∅',
      label,
      calls,
      inputTokens: i,
      outputTokens: o,
      costUsd: cost,
      costEur: cost * rate,
    });

    const byAction = byActionRaw
      .map((r) => row(r.action, ACTION_LABELS[r.action] ?? r.action, r._count._all, r._sum.inputTokens ?? 0, r._sum.outputTokens ?? 0, r._sum.costUsd ?? 0))
      .sort((a, b) => b.costUsd - a.costUsd);
    const byFleet = byFleetRaw
      .map((r) => row(r.fleetId, r.fleetId ? (fleetName.get(r.fleetId) ?? 'Flotte inconnue') : '— (hors flotte)', r._count._all, r._sum.inputTokens ?? 0, r._sum.outputTokens ?? 0, r._sum.costUsd ?? 0))
      .sort((a, b) => b.costUsd - a.costUsd);
    const byUser = byUserRaw
      .map((r) => row(r.userId, r.userId ? (userEmail.get(r.userId) ?? 'Utilisateur inconnu') : '— (système)', r._count._all, r._sum.inputTokens ?? 0, r._sum.outputTokens ?? 0, r._sum.costUsd ?? 0))
      .sort((a, b) => b.costUsd - a.costUsd);
    const byDay = dayRows.map((d) => {
      const iso = d.day.toISOString().slice(0, 10);
      return row(iso, iso, Number(d.calls), 0, 0, Number(d.cost));
    });

    const totalCostUsd = agg._sum.costUsd ?? 0;
    // Budget : global (super-admin) OU vue scopée flotte (visibilité seule, pas de plafond par flotte).
    const budget = scopeFleetId ? await this.fleetBudgetView(scopeFleetId, rate, viewer) : await this.getBudget(viewer);
    // Flotte scopée : identité + interrupteur maître IA → pilotage de l'IA PAR SOCIÉTÉ depuis la page.
    const scopedFleet = scopeFleetId
      ? await this.prisma.fleet.findUnique({ where: { id: scopeFleetId }, select: { id: true, name: true, aiEnabled: true } })
      : null;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalCalls: agg._count._all,
      totalInputTokens: agg._sum.inputTokens ?? 0,
      totalOutputTokens: agg._sum.outputTokens ?? 0,
      totalCacheReadTokens: agg._sum.cacheReadTokens ?? 0,
      totalCostUsd,
      totalCostEur: totalCostUsd * rate,
      usdToEurRate: rate,
      byAction,
      byFleet,
      byUser,
      byDay,
      budget,
      scopedFleet: scopedFleet ?? null,
    };
  }

  async logs(opts: { limit?: number; before?: string; after?: string; userId?: string; fleetId?: string; action?: string }, viewer: { isOwner?: boolean | null } = {}): Promise<AiUsageLogsPageDto> {
    const rate = this.usdToEur();
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: Prisma.AiUsageLogWhereInput = {};
    if (opts.userId) where.userId = opts.userId;
    if (opts.fleetId) where.fleetId = opts.fleetId;
    if (opts.action) where.action = opts.action;
    // Fenêtre temporelle : `before` = curseur de pagination (borne haute exclusive) ; `after` = borne
    // basse (filtre JOUR précis). Les deux peuvent coexister (journal borné à un jour + pagination).
    const createdAt: Prisma.DateTimeFilter = {};
    if (opts.before) { const d = new Date(opts.before); if (!Number.isNaN(d.getTime())) createdAt.lt = d; }
    if (opts.after) { const d = new Date(opts.after); if (!Number.isNaN(d.getTime())) createdAt.gte = d; }
    if (createdAt.lt || createdAt.gte) where.createdAt = createdAt;
    // Owner plateforme — appels IA de l'owner exclus pour un viewer non-owner
    // (userId nullable → on conserve les null système).
    if (this.ownerVis.isMasked(viewer)) {
      const ownerIds = await this.ownerVis.getOwnerIds();
      if (ownerIds.length) where.OR = [{ userId: null }, { userId: { notIn: ownerIds } }];
    }
    const rows = await this.prisma.aiUsageLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: take + 1 });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    const fleetIds = [...new Set(page.map((r) => r.fleetId).filter((x): x is string => !!x))];
    const userIds = [...new Set(page.map((r) => r.userId).filter((x): x is string => !!x))];
    const [fleets, users] = await Promise.all([
      fleetIds.length ? this.prisma.fleet.findMany({ where: { id: { in: fleetIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [],
    ]);
    const fleetName = new Map(fleets.map((f) => [f.id, f.name]));
    const userEmail = new Map(users.map((u) => [u.id, u.email]));

    return {
      rows: page.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        userId: r.userId,
        userEmail: r.userId ? (userEmail.get(r.userId) ?? null) : null,
        fleetId: r.fleetId,
        fleetName: r.fleetId ? (fleetName.get(r.fleetId) ?? null) : null,
        model: r.model,
        action: r.action,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        costUsd: r.costUsd,
        costEur: r.costUsd * rate,
        latencyMs: r.latencyMs,
        ok: r.ok,
      })),
      nextCursor: hasMore ? page[page.length - 1].createdAt.toISOString() : null,
    };
  }

  // ─── Coût par flotte (visibilité) ──────────────────────────────────────────

  private monthStart(): Date {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Fragment WHERE excluant les appels IA de l'owner plateforme pour un viewer non-owner. IDENTIQUE
   * à la logique de `summary`/`logs` : sans lui, la DÉPENSE DU MOIS (budget) trahirait un coût masqué
   * (delta entre « dépensé » et Σ des lignes par utilisateur). `userId` NULLABLE (appels système) → on
   * conserve les null. Masque par DÉFAUT (viewer omis = non-owner) : sûr.
   */
  private async ownerAiExclusion(viewer: { isOwner?: boolean | null }): Promise<Prisma.AiUsageLogWhereInput> {
    if (!this.ownerVis.isMasked(viewer)) return {};
    const ownerIds = await this.ownerVis.getOwnerIds();
    return ownerIds.length ? { OR: [{ userId: null }, { userId: { notIn: ownerIds } }] } : {};
  }

  /** Dépense IA (USD) d'une flotte depuis le 1er du mois courant (owner exclu pour un viewer non-owner). */
  private async fleetMonthSpendUsd(fleetId: string, viewer: { isOwner?: boolean | null } = {}): Promise<number> {
    const agg = await this.prisma.aiUsageLog.aggregate({
      where: { fleetId, createdAt: { gte: this.monthStart() }, ...(await this.ownerAiExclusion(viewer)) },
      _sum: { costUsd: true },
    });
    return agg._sum.costUsd ?? 0;
  }

  /** Coût IA (€) d'une flotte depuis le 1er du mois — pour la ⚙️ agenda + les vues scopées. */
  async monthCostEur(fleetId: string, viewer: { isOwner?: boolean | null } = {}): Promise<number> {
    return (await this.fleetMonthSpendUsd(fleetId, viewer)) * this.usdToEur();
  }

  /** Vue budget SCOPÉE flotte : pas de plafond par flotte (visibilité seule), juste la dépense du mois. */
  private async fleetBudgetView(fleetId: string, rate: number, viewer: { isOwner?: boolean | null } = {}): Promise<AiUsageBudgetDto> {
    const usd = await this.fleetMonthSpendUsd(fleetId, viewer);
    return {
      monthlyBudgetEur: 0,
      spentThisMonthEur: usd * rate,
      spentThisMonthUsd: usd,
      status: 'none',
      usdToEurRate: rate,
      updatedAt: null,
    };
  }

  // ─── Budget mensuel (singleton) ────────────────────────────────────────────

  async getBudget(viewer: { isOwner?: boolean | null } = {}): Promise<AiUsageBudgetDto> {
    const rate = this.usdToEur();
    const row = await this.prisma.aiBudget.findFirst({ orderBy: { updatedAt: 'desc' } });
    const monthlyBudgetEur = row?.monthlyBudgetEur ?? 0;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    // Owner plateforme exclu de la dépense du mois pour un viewer non-owner (cohérent avec summary/logs).
    const agg = await this.prisma.aiUsageLog.aggregate({ where: { createdAt: { gte: monthStart }, ...(await this.ownerAiExclusion(viewer)) }, _sum: { costUsd: true } });
    const spentThisMonthUsd = agg._sum.costUsd ?? 0;
    const spentThisMonthEur = spentThisMonthUsd * rate;
    let status: AiBudgetStatus = 'none';
    if (monthlyBudgetEur > 0) {
      const ratio = spentThisMonthEur / monthlyBudgetEur;
      status = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok';
    }
    return {
      monthlyBudgetEur,
      spentThisMonthEur,
      spentThisMonthUsd,
      status,
      usdToEurRate: rate,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  async setBudget(monthlyBudgetEur: number, userId?: string, viewer: { isOwner?: boolean | null } = {}): Promise<AiUsageBudgetDto> {
    const value = Number.isFinite(monthlyBudgetEur) && monthlyBudgetEur >= 0 ? monthlyBudgetEur : 0;
    const existing = await this.prisma.aiBudget.findFirst();
    if (existing) {
      await this.prisma.aiBudget.update({ where: { id: existing.id }, data: { monthlyBudgetEur: value, updatedByUserId: userId ?? null } });
    } else {
      await this.prisma.aiBudget.create({ data: { monthlyBudgetEur: value, updatedByUserId: userId ?? null } });
    }
    return this.getBudget(viewer);
  }
}
