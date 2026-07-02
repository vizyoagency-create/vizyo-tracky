import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, UserRole } from '@prisma/client';
import {
  effectiveBlockingEndMs,
  estimateCostPerKm,
  isImmobilizingEvent,
  type AgendaOptimizationDashboardDto,
  type AgendaOptimizationOrigin,
  type AgendaOptimizationReportDto,
  type AgendaOptimizationScheduleDto,
  type AgendaReportStatus,
  type AiAgendaProposalDto,
  type ApplyAgendaProposalDto,
  type ForecastWeekBucketDto,
  type OptimizationOpportunityDto,
  type SetAgendaOptimizationScheduleDto,
  type VehicleEventDto,
} from '@vizyo/tracky-shared';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { AnthropicClient } from '../ai/anthropic.client';
import type { AuthUser } from '../auth/types/auth-user';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { AGENDA_OPTIMIZATION_SCHEMA, AGENDA_OPTIMIZATION_SYSTEM } from './agenda-optimization.prompt';
import { ForecastService } from './forecast.service';
import { FleetInsightsService } from './fleet-insights.service';
import { ReservationsService } from './reservations.service';
import { VehicleEventsService } from './vehicle-events.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Marqueur "système" (createdBy des événements auto-générés — pas de FK, simple traçabilité). */
const SYSTEM_UUID = '00000000-0000-0000-0000-000000000000';
/** Bornes du payload IA (perf + coût). */
const AI_MAX_RESERVATIONS = 200;
const AI_MAX_FORECAST = 300;
type AiAgendaOutput = { summary?: string; proposals?: Array<Partial<AiAgendaProposalDto>> };
/** Horizon de la vue d'optimisation : ≈ 2 mois. */
const HORIZON_DAYS = 60;
/** Fenêtre d'apprentissage de l'utilisation (mutualisation) : 28 jours passés. */
const UTIL_WINDOW_DAYS = 28;
const MAX_OPPORTUNITIES = 12;
/** Fraction des km combustion supposée « urbaine / basculable » vers l'électrique (conservateur). */
const SHIFTABLE_FRACTION = 0.25;
/** Capacité mensuelle indicative qu'un électrique sous-utilisé peut absorber (km). */
const ELECTRIC_SPARE_KM_PER_MONTH = 800;

type VehRow = {
  id: string;
  plate: string | null;
  energy: string | null;
  seats: number | null;
  fuelConsumptionL100km: number | null;
};

/**
 * Agenda AI (Palier 1) — Dashboard d'optimisation DÉTERMINISTE sur 2 mois : timeline
 * hebdomadaire de la charge prévue + opportunités calculées SANS IA (sous-utilisation,
 * coût/énergie, maintenances dues, jours en tension). Réutilise `ForecastService`,
 * `FleetInsightsService` et `VehicleEventsService`. Scoping tenant STRICT (chaîne S5).
 * Les PROPOSITIONS de l'agent IA sont ajoutées au Palier 3 (mêmes tables).
 */
@Injectable()
export class AgendaOptimizationService {
  private readonly logger = new Logger(AgendaOptimizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly forecast: ForecastService,
    private readonly insights: FleetInsightsService,
    private readonly events: VehicleEventsService,
    private readonly reservations: ReservationsService,
    private readonly anthropic: AnthropicClient,
    private readonly aiUsage: AiUsageService,
    private readonly systemActivity: SystemActivityService,
    private readonly errors: ErrorLogger,
  ) {}

  /** Utilisateur SYSTÈME (super-admin synthétique) pour les lectures des exécutions planifiées. */
  private systemReader(fleetId: string): AuthUser {
    return {
      id: SYSTEM_UUID, authUserId: SYSTEM_UUID, email: 'system@tracky', firstName: null, lastName: null,
      role: UserRole.SUPER_ADMIN, fleetId, isActive: true, permissions: null,
    };
  }

  // ─── Scope ───────────────────────────────────────────────────────────────

  /** Résout la flotte cible + ses véhicules accessibles (anti-IDOR). */
  private async resolveFleet(
    user: AuthUser,
    fleetId?: string,
  ): Promise<{ fleetId: string; vehicles: VehRow[]; vehicleIds: Set<string> }> {
    let target: string;
    if (user.role === UserRole.SUPER_ADMIN) {
      if (!fleetId) throw new BadRequestException('fleetId requis (super-admin).');
      target = fleetId;
    } else {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associée');
      if (fleetId && fleetId !== user.fleetId) throw new ForbiddenException('Flotte hors de votre périmètre');
      target = user.fleetId;
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const where: Prisma.VehicleWhereInput = { fleetId: target };
    if (accessible !== 'ALL') where.id = { in: accessible };
    const vehicles = await this.prisma.vehicle.findMany({
      where,
      select: { id: true, plate: true, energy: true, seats: true, fuelConsumptionL100km: true },
      take: 5000,
    });
    return { fleetId: target, vehicles, vehicleIds: new Set(vehicles.map((v) => v.id)) };
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────

  async getDashboard(user: AuthUser, fleetId?: string): Promise<AgendaOptimizationDashboardDto> {
    const { fleetId: fid, vehicles, vehicleIds } = await this.resolveFleet(user, fleetId);

    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + HORIZON_DAYS * DAY_MS);
    const utilFrom = new Date(from.getTime() - UTIL_WINDOW_DAYS * DAY_MS);

    const [gathered, latestReport, schedule] = await Promise.all([
      this.gather(user, from, to, utilFrom, vehicleIds),
      this.loadLatestReport(fid),
      this.getSchedule(user, fid),
    ]);
    const { events, forecastSlots, utilVehicles } = gathered;

    const { weeks, tensionDays } = this.buildTimeline(from, to, forecastSlots, events, vehicles.length);
    const opportunities = this.buildOpportunities(vehicles, utilVehicles, events, from, to, tensionDays);

    const savings = opportunities
      .filter((o) => o.kind === 'cost_energy' || o.kind === 'mutualize')
      .reduce((s, o) => s + (o.savingsEurPerMonth ?? 0), 0);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      fleetId: fid,
      weeks,
      underutilizedCount: utilVehicles.filter((v) => v.underutilized).length,
      potentialSavingsEurPerMonth: Math.round(savings),
      maintenanceDueCount: opportunities.filter((o) => o.kind === 'maintenance_due').reduce((s, o) => s + o.vehicleIds.length, 0),
      tensionDaysCount: tensionDays.size,
      opportunities,
      latestReport,
      schedule,
    };
  }

  /** Collecte + filtre au périmètre flotte (prévision, événements, utilisation). Réutilisé agent. */
  private async gather(
    user: AuthUser,
    from: Date,
    to: Date,
    utilFrom: Date,
    vehicleIds: Set<string>,
  ): Promise<{
    events: VehicleEventDto[];
    forecastSlots: { vehicleId: string; vehiclePlate: string | null; startAt: string; endAt: string; dayOfWeek: number; basis: string; confidence: number }[];
    utilVehicles: { vehicleId: string; vehiclePlate: string | null; underutilized: boolean; distanceKm: number; utilizationRatio: number; freePatterns: string[] }[];
  }> {
    const [forecastRes, allEvents, utilization] = await Promise.all([
      this.forecast.getForecast(user, from, to),
      this.events.list(user, { from, to }),
      this.insights.getUtilization(user, utilFrom, from),
    ]);
    return {
      events: allEvents.filter((e) => vehicleIds.has(e.vehicleId)),
      forecastSlots: forecastRes.slots.filter((s) => vehicleIds.has(s.vehicleId)),
      utilVehicles: utilization.vehicles.filter((v) => vehicleIds.has(v.vehicleId)),
    };
  }

  // ─── Timeline hebdomadaire (prévision + événements) ──────────────────────

  private buildTimeline(
    from: Date,
    to: Date,
    forecastSlots: { vehicleId: string; startAt: string }[],
    events: VehicleEventDto[],
    totalVehicles: number,
  ): { weeks: ForecastWeekBucketDto[]; tensionDays: Set<number> } {
    const fromMs = from.getTime();
    const nDays = HORIZON_DAYS;
    const dayIdx = (ms: number) => Math.floor((ms - fromMs) / DAY_MS);

    const predictedByDay: Array<Set<string>> = Array.from({ length: nDays }, () => new Set());
    const reservedByDay: Array<Set<string>> = Array.from({ length: nDays }, () => new Set());
    const immobilizedByDay: Array<Set<string>> = Array.from({ length: nDays }, () => new Set());

    for (const s of forecastSlots) {
      const d = dayIdx(new Date(s.startAt).getTime());
      if (d >= 0 && d < nDays) predictedByDay[d].add(s.vehicleId);
    }
    for (const ev of events) {
      const st = new Date(ev.startAt).getTime();
      if (Number.isNaN(st)) continue;
      const endMs = effectiveBlockingEndMs(ev.type, st, ev.endAt ? new Date(ev.endAt).getTime() : null);
      const startDay = Math.max(0, dayIdx(st));
      const endDay = Number.isFinite(endMs) ? Math.min(nDays - 1, dayIdx(endMs)) : nDays - 1;
      if (ev.type === 'RESERVATION' && (ev.status === 'CONFIRMED' || ev.status === 'IN_PROGRESS')) {
        for (let d = startDay; d <= endDay; d++) reservedByDay[d]?.add(ev.vehicleId);
      } else if (isImmobilizingEvent(ev)) {
        for (let d = startDay; d <= endDay; d++) immobilizedByDay[d]?.add(ev.vehicleId);
      }
    }

    // Tension par jour : véhicules requis (prévus ∪ réservés) > véhicules disponibles.
    const tensionDays = new Set<number>();
    for (let d = 0; d < nDays; d++) {
      const demand = new Set<string>([...predictedByDay[d], ...reservedByDay[d]]).size;
      const available = totalVehicles - immobilizedByDay[d].size;
      if (demand > 0 && demand > available) tensionDays.add(d);
    }

    // Agrégation hebdomadaire (semaines ISO, lundi).
    const weeks: ForecastWeekBucketDto[] = [];
    let cursor = startOfWeekMonday(from);
    const guard = Math.ceil(HORIZON_DAYS / 7) + 2;
    for (let w = 0; w < guard && cursor.getTime() < to.getTime(); w++) {
      const wStart = cursor.getTime();
      const wEnd = wStart + 7 * DAY_MS;
      const predicted = new Set<string>();
      let reservations = 0;
      let maintenances = 0;
      let incidents = 0;
      let tension = false;
      for (let d = 0; d < nDays; d++) {
        const dayMs = fromMs + d * DAY_MS;
        if (dayMs < wStart || dayMs >= wEnd) continue;
        for (const v of predictedByDay[d]) predicted.add(v);
        if (tensionDays.has(d)) tension = true;
      }
      for (const ev of events) {
        const st = new Date(ev.startAt).getTime();
        if (st < wStart || st >= wEnd) continue;
        if (ev.type === 'RESERVATION') reservations++;
        else if (ev.type === 'MAINTENANCE') maintenances++;
        else if (ev.type === 'INCIDENT') incidents++;
      }
      weeks.push({
        weekStart: new Date(wStart).toISOString(),
        isoWeek: isoWeekNumber(new Date(wStart)),
        predictedVehicles: predicted.size,
        reservations,
        maintenances,
        incidents,
        tension,
      });
      cursor = new Date(wEnd);
    }
    return { weeks, tensionDays };
  }

  // ─── Opportunités déterministes ──────────────────────────────────────────

  private buildOpportunities(
    vehicles: VehRow[],
    utilVehicles: { vehicleId: string; vehiclePlate: string | null; underutilized: boolean; distanceKm: number; freePatterns: string[] }[],
    events: VehicleEventDto[],
    from: Date,
    to: Date,
    tensionDays: Set<number>,
  ): OptimizationOpportunityDto[] {
    const out: OptimizationOpportunityDto[] = [];
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    const plateOf = (id: string) => byId.get(id)?.plate ?? '—';

    // 1) Mutualisation : véhicules franchement sous-utilisés (avec créneaux libres récurrents).
    const under = utilVehicles.filter((v) => v.underutilized);
    if (under.length > 0) {
      const plates = under.slice(0, 8).map((v) => v.vehiclePlate ?? '—');
      const patterns = under.find((v) => v.freePatterns.length > 0)?.freePatterns ?? [];
      out.push({
        kind: 'mutualize',
        title: `${under.length} véhicule(s) sous-utilisé(s) à mutualiser`,
        detail:
          `Ces véhicules roulent peu sur les 4 dernières semaines` +
          (patterns.length ? ` (souvent libres : ${patterns.slice(0, 3).join(', ')})` : '') +
          `. Regroupez des trajets dessus plutôt que d'en mobiliser d'autres.`,
        severity: 'info',
        savingsEurPerMonth: null,
        vehicleIds: under.map((v) => v.vehicleId),
        vehiclePlates: plates,
      });
    }

    // 2) Coût / énergie : basculer des trajets combustion vers des électriques sous-utilisés.
    const utilById = new Map(utilVehicles.map((v) => [v.vehicleId, v]));
    const elecUnderused = vehicles.filter((v) => v.energy === 'ELECTRIQUE' && utilById.get(v.id)?.underutilized);
    const combustion = vehicles.filter((v) => v.energy === 'DIESEL' || v.energy === 'ESSENCE' || v.energy === 'HYBRIDE');
    if (elecUnderused.length > 0 && combustion.length > 0) {
      const monthFactor = 30 / UTIL_WINDOW_DAYS;
      const combustionMonthlyKm = combustion.reduce((s, v) => s + (utilById.get(v.id)?.distanceKm ?? 0), 0) * monthFactor;
      const costs = combustion.map((v) => estimateCostPerKm(v.energy, v.fuelConsumptionL100km)).filter((x): x is number => x != null);
      const avgCombustionCost = costs.length ? costs.reduce((s, c) => s + c, 0) / costs.length : 0.12;
      const shiftableKm = Math.min(
        SHIFTABLE_FRACTION * combustionMonthlyKm,
        elecUnderused.length * ELECTRIC_SPARE_KM_PER_MONTH,
      );
      const savings = Math.max(0, Math.round(shiftableKm * (avgCombustionCost - 0.03)));
      if (savings >= 5) {
        out.push({
          kind: 'cost_energy',
          title: `Basculer des trajets urbains vers ${elecUnderused.length} véhicule(s) électrique(s)`,
          detail:
            `${elecUnderused.length} électrique(s) peu utilisé(s) coûtent ~0,03 €/km contre ~${avgCombustionCost
              .toFixed(2)
              .replace('.', ',')} €/km en carburant. En y basculant les trajets urbains, vous économisez ~${savings} €/mois.`,
          severity: 'info',
          savingsEurPerMonth: savings,
          vehicleIds: elecUnderused.map((v) => v.id),
          vehiclePlates: elecUnderused.slice(0, 8).map((v) => v.plate ?? '—'),
        });
      }
    }

    // 3) Maintenances dues sur l'horizon (déjà planifiées OU échéance de plan à venir).
    const plannedMaint = events.filter(
      (e) => e.type === 'MAINTENANCE' && (e.status === 'PLANNED' || e.status === 'OPEN'),
    );
    if (plannedMaint.length > 0) {
      const ids = [...new Set(plannedMaint.map((e) => e.vehicleId))];
      out.push({
        kind: 'maintenance_due',
        title: `${plannedMaint.length} maintenance(s) à planifier ou à venir`,
        detail: `À caler avant leur échéance pour éviter une immobilisation subie qui bloquerait des réservations.`,
        severity: 'warning',
        vehicleIds: ids,
        vehiclePlates: ids.slice(0, 8).map(plateOf),
        atDate: plannedMaint.map((e) => e.startAt).sort()[0] ?? null,
      });
    }

    // 4) Jours en tension (demande prévue > flotte disponible).
    if (tensionDays.size > 0) {
      const fromMs = from.getTime();
      const firstDay = [...tensionDays].sort((a, b) => a - b)[0];
      out.push({
        kind: 'tension',
        title: `${tensionDays.size} jour(s) en tension sur 2 mois`,
        detail:
          `Certains jours, la demande prévue dépasse le nombre de véhicules disponibles ` +
          `(immobilisations comprises). Anticipez en mutualisant ou en décalant des courses.`,
        severity: tensionDays.size >= 3 ? 'critical' : 'warning',
        vehicleIds: [],
        vehiclePlates: [],
        atDate: new Date(fromMs + firstDay * DAY_MS).toISOString(),
      });
    }

    const rank: Record<OptimizationOpportunityDto['severity'], number> = { critical: 0, warning: 1, info: 2 };
    return out
      .sort((a, b) => rank[a.severity] - rank[b.severity] || (b.savingsEurPerMonth ?? 0) - (a.savingsEurPerMonth ?? 0))
      .slice(0, MAX_OPPORTUNITIES);
  }

  // ─── Planification / config (par flotte) ─────────────────────────────────

  async getSchedule(user: AuthUser, fleetId?: string): Promise<AgendaOptimizationScheduleDto> {
    const fid = fleetId ?? (user.role === UserRole.SUPER_ADMIN ? undefined : user.fleetId ?? undefined);
    const row = fid ? await this.prisma.agendaOptimizationSchedule.findUnique({ where: { fleetId: fid } }) : null;
    return {
      fleetId: fid ?? null,
      enabled: row?.enabled ?? false,
      frequency: (row?.frequency as AgendaOptimizationScheduleDto['frequency']) ?? 'daily',
      autonomy: (row?.autonomy as AgendaOptimizationScheduleDto['autonomy']) ?? 'PROPOSE',
      lastRunAt: row?.lastRunAt?.toISOString() ?? null,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  async setSchedule(user: AuthUser, dto: SetAgendaOptimizationScheduleDto): Promise<AgendaOptimizationScheduleDto> {
    const { fleetId } = await this.resolveFleet(user, dto.fleetId); // valide l'accès à la flotte
    const data = {
      enabled: !!dto.enabled,
      frequency: dto.frequency === 'weekly' ? 'weekly' : 'daily',
      autonomy: dto.autonomy === 'AUTO' ? 'AUTO' : 'PROPOSE',
      updatedByUserId: user.id,
    } as const;
    await this.prisma.agendaOptimizationSchedule.upsert({
      where: { fleetId },
      create: { fleetId, ...data },
      update: data,
    });
    return this.getSchedule(user, fleetId);
  }

  // ─── Rapports (lecture ; génération IA = Palier 3) ───────────────────────

  private async loadLatestReport(fleetId: string): Promise<AgendaOptimizationReportDto | null> {
    const row = await this.prisma.agendaOptimizationReport.findFirst({
      where: { fleetId, status: 'READY' },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.reportToDto(row) : null;
  }

  reportToDto(row: {
    id: string;
    createdAt: Date;
    fleetId: string;
    fromAt: Date;
    toAt: Date;
    status: string;
    origin: string;
    summary: string | null;
    proposals: unknown;
    error: string | null;
    costUsd: number;
  }): AgendaOptimizationReportDto {
    const proposals = Array.isArray(row.proposals) ? (row.proposals as AiAgendaProposalDto[]) : [];
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      fleetId: row.fleetId,
      from: row.fromAt.toISOString(),
      to: row.toAt.toISOString(),
      status: row.status as AgendaReportStatus,
      origin: row.origin as AgendaOptimizationReportDto['origin'],
      summary: row.summary,
      proposals,
      error: row.error,
      costEur: Math.round(row.costUsd * 0.92 * 10000) / 10000,
    };
  }

  // ─── Agent IA — génération / application / planification ──────────────────

  /** Lance une analyse IA à la demande (utilisateur). Perm ai_optimize (contrôleur). */
  async runOnDemand(user: AuthUser, fleetId?: string): Promise<AgendaOptimizationReportDto> {
    const { fleetId: fid } = await this.resolveFleet(user, fleetId);
    return this.runAnalysis(user, user.id, fid, 'manual');
  }

  async listReports(user: AuthUser, fleetId?: string, limit = 20): Promise<AgendaOptimizationReportDto[]> {
    const { fleetId: fid } = await this.resolveFleet(user, fleetId);
    const rows = await this.prisma.agendaOptimizationReport.findMany({
      where: { fleetId: fid },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 50),
    });
    return rows.map((r) => this.reportToDto(r));
  }

  /**
   * Génère un rapport d'optimisation IA pour une flotte : construit le payload (véhicules, coûts,
   * réservations, maintenances, incidents, prévision, tensions), fait analyser par Claude, filtre
   * les hallucinations, PERSISTE, journalise le coût (Coûts IA) + l'activité + les échecs (alerte).
   * En mode AUTO : applique automatiquement les propositions SÛRES (planif de maintenance).
   */
  async runAnalysis(
    reader: AuthUser,
    actorUserId: string | null,
    fleetId: string,
    origin: AgendaOptimizationOrigin,
    trigger?: string,
  ): Promise<AgendaOptimizationReportDto> {
    const { fleetId: fid, vehicles, vehicleIds } = await this.resolveFleet(reader, fleetId);
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + HORIZON_DAYS * DAY_MS);
    const utilFrom = new Date(from.getTime() - UTIL_WINDOW_DAYS * DAY_MS);
    const { events, forecastSlots, utilVehicles } = await this.gather(reader, from, to, utilFrom, vehicleIds);
    const { tensionDays } = this.buildTimeline(from, to, forecastSlots, events, vehicles.length);
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fid }, select: { name: true, metier: true } });

    const payload = this.buildAiPayload(fleet, vehicles, utilVehicles, events, forecastSlots, tensionDays, from, to);
    const validResa = new Set(events.filter((e) => e.type === 'RESERVATION').map((e) => e.id));

    try {
      const call = await this.anthropic.completeJson<AiAgendaOutput>({
        system: AGENDA_OPTIMIZATION_SYSTEM,
        userPayload: payload,
        schema: AGENDA_OPTIMIZATION_SCHEMA,
        maxTokens: 4096,
      });
      const proposals = this.sanitizeProposals(call.result?.proposals, vehicleIds, validResa, vehicles);
      const costUsd = this.aiUsage.costOf(call.model, call.usage);
      void this.aiUsage.record({
        userId: actorUserId, fleetId: fid, action: 'agenda_optimization', model: call.model,
        inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
        cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
        latencyMs: call.latencyMs, ok: true,
      });
      const row = await this.prisma.agendaOptimizationReport.create({
        data: {
          fleetId: fid, createdByUserId: actorUserId, fromAt: from, toAt: to, status: 'READY',
          origin, trigger: trigger ?? null, summary: clip(call.result?.summary, 1500) || null,
          proposals: proposals as unknown as Prisma.InputJsonValue, model: call.model, costUsd,
        },
      });
      this.trackRun(fid, origin, 'SUCCESS', actorUserId, { reportId: row.id, proposals: proposals.length, costUsd });

      const schedule = await this.getSchedule(reader, fid);
      if (schedule.autonomy === 'AUTO') await this.autoApply(reader, row.id, fid, proposals);
      const fresh = await this.prisma.agendaOptimizationReport.findUniqueOrThrow({ where: { id: row.id } });
      return this.reportToDto(fresh);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Analyse agenda IA en échec (flotte ${fid}) : ${message}`);
      await this.recordFailure(err, fid, actorUserId ?? undefined);
      const row = await this.prisma.agendaOptimizationReport.create({
        data: {
          fleetId: fid, createdByUserId: actorUserId, fromAt: from, toAt: to, status: 'FAILED',
          origin, trigger: trigger ?? null, error: message.slice(0, 400), costUsd: 0,
        },
      });
      this.trackRun(fid, origin, 'FAILURE', actorUserId, { reportId: row.id });
      return this.reportToDto(row);
    }
  }

  /** Applique une proposition (validation humaine). */
  async applyProposal(user: AuthUser, dto: ApplyAgendaProposalDto): Promise<AgendaOptimizationReportDto> {
    const report = await this.loadReportScoped(user, dto.reportId);
    const proposals = Array.isArray(report.proposals) ? (report.proposals as unknown as AiAgendaProposalDto[]) : [];
    const p = proposals.find((x) => x.id === dto.proposalId);
    if (!p) throw new NotFoundException('Proposition introuvable.');
    if (p.status !== 'pending') return this.reportToDto(report);
    await this.executeProposal(user, p); // lève 409 si conflit (véhicule cible pris, etc.)
    p.status = 'applied';
    await this.prisma.agendaOptimizationReport.update({
      where: { id: report.id },
      data: { proposals: proposals as unknown as Prisma.InputJsonValue },
    });
    this.systemActivity.record({
      category: 'AI', action: 'agenda_proposal_applied', status: 'SUCCESS', actor: 'utilisateur',
      target: p.title, detail: p.why, fleetId: report.fleetId, triggeredByUserId: user.id,
      meta: { kind: p.kind, reportId: report.id },
    });
    return this.reportToDto(await this.prisma.agendaOptimizationReport.findUniqueOrThrow({ where: { id: report.id } }));
  }

  /** Rejette une proposition (l'utilisateur ne la retient pas). */
  async dismissProposal(user: AuthUser, dto: ApplyAgendaProposalDto): Promise<AgendaOptimizationReportDto> {
    const report = await this.loadReportScoped(user, dto.reportId);
    const proposals = Array.isArray(report.proposals) ? (report.proposals as unknown as AiAgendaProposalDto[]) : [];
    const p = proposals.find((x) => x.id === dto.proposalId);
    if (!p) throw new NotFoundException('Proposition introuvable.');
    if (p.status === 'pending') {
      p.status = 'dismissed';
      await this.prisma.agendaOptimizationReport.update({
        where: { id: report.id },
        data: { proposals: proposals as unknown as Prisma.InputJsonValue },
      });
    }
    return this.reportToDto(await this.prisma.agendaOptimizationReport.findUniqueOrThrow({ where: { id: report.id } }));
  }

  /** Exécute une proposition via les flux existants (gardes/scoping/conflits inclus). */
  private async executeProposal(user: AuthUser, p: AiAgendaProposalDto): Promise<void> {
    if (p.kind === 'reassign') {
      if (!p.reservationId || !p.vehicleId) throw new BadRequestException('Réassignation incomplète.');
      await this.reservations.reassign(user, p.reservationId, p.vehicleId);
    } else if (p.kind === 'schedule_maintenance') {
      if (!p.vehicleId) throw new BadRequestException('Maintenance sans véhicule cible.');
      const startAt = p.startAt ?? new Date().toISOString();
      await this.events.create(user, {
        vehicleId: p.vehicleId, type: 'MAINTENANCE', title: clip(p.title, 160) || 'Maintenance planifiée',
        description: p.why, startAt, endAt: p.endAt ?? undefined, allDay: !p.startAt || !p.endAt, status: 'PLANNED',
      });
    }
    // 'mutualize' / 'note' : conseils (aucune écriture), simplement marqués « appliqués » (acquittés).
  }

  /** Mode AUTO : applique seulement le SÛR (planif de maintenance) ; le reste reste proposé. */
  private async autoApply(user: AuthUser, reportId: string, fleetId: string, proposals: AiAgendaProposalDto[]): Promise<void> {
    let changed = false;
    for (const p of proposals) {
      if (p.kind !== 'schedule_maintenance') continue;
      try {
        await this.executeProposal(user, p);
        p.status = 'applied';
        changed = true;
        this.systemActivity.record({
          category: 'AI', action: 'agenda_proposal_auto_applied', status: 'SUCCESS', actor: 'planning',
          target: p.title, detail: p.why, fleetId, meta: { kind: p.kind, reportId },
        });
      } catch (e) {
        this.logger.warn(`Auto-apply proposition échouée : ${(e as Error)?.message}`);
      }
    }
    if (changed) {
      await this.prisma.agendaOptimizationReport.update({
        where: { id: reportId },
        data: { proposals: proposals as unknown as Prisma.InputJsonValue },
      });
    }
  }

  private async loadReportScoped(user: AuthUser, id: string) {
    const row = await this.prisma.agendaOptimizationReport.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Rapport introuvable.');
    if (user.role !== UserRole.SUPER_ADMIN && row.fleetId !== user.fleetId) {
      throw new NotFoundException('Rapport introuvable.');
    }
    return row;
  }

  private buildAiPayload(
    fleet: { name: string | null; metier: string } | null,
    vehicles: VehRow[],
    utilVehicles: { vehicleId: string; underutilized: boolean; utilizationRatio: number }[],
    events: VehicleEventDto[],
    forecastSlots: { vehicleId: string; vehiclePlate: string | null; startAt: string; dayOfWeek: number; basis: string; confidence: number }[],
    tensionDays: Set<number>,
    from: Date,
    to: Date,
  ) {
    const utilById = new Map(utilVehicles.map((v) => [v.vehicleId, v]));
    const fromMs = from.getTime();
    const isResa = (e: VehicleEventDto) => e.type === 'RESERVATION' && (e.status === 'CONFIRMED' || e.status === 'IN_PROGRESS' || e.status === 'REQUESTED');
    return {
      fleetName: fleet?.name ?? null,
      metier: fleet?.metier ?? 'GENERIC',
      period: { from: from.toISOString(), to: to.toISOString() },
      vehicles: vehicles.map((v) => ({
        vehicleId: v.id, plate: v.plate, seats: v.seats, energy: v.energy,
        costPerKm: estimateCostPerKm(v.energy, v.fuelConsumptionL100km),
        utilizationRatio: utilById.get(v.id)?.utilizationRatio ?? 0,
        underutilized: utilById.get(v.id)?.underutilized ?? false,
      })),
      reservations: events.filter(isResa).slice(0, AI_MAX_RESERVATIONS).map((e) => ({
        reservationId: e.id, vehicleId: e.vehicleId, plate: e.vehiclePlate,
        startAt: e.startAt, endAt: e.endAt, title: e.title, status: e.status,
      })),
      maintenances: events.filter((e) => e.type === 'MAINTENANCE').slice(0, 100).map((e) => ({
        vehicleId: e.vehicleId, plate: e.vehiclePlate, startAt: e.startAt, endAt: e.endAt,
        title: e.title, status: e.status, blocksVehicle: e.blocksVehicle,
      })),
      incidents: events.filter((e) => e.type === 'INCIDENT').slice(0, 100).map((e) => ({
        vehicleId: e.vehicleId, plate: e.vehiclePlate, startAt: e.startAt, title: e.title,
        severity: e.severity, blocksVehicle: e.blocksVehicle,
      })),
      forecast: forecastSlots.slice(0, AI_MAX_FORECAST).map((s) => ({
        vehicleId: s.vehicleId, plate: s.vehiclePlate, startAt: s.startAt, dayOfWeek: s.dayOfWeek, basis: s.basis, confidence: s.confidence,
      })),
      tensionDays: [...tensionDays].sort((a, b) => a - b).slice(0, 20).map((d) => new Date(fromMs + d * DAY_MS).toISOString().slice(0, 10)),
    };
  }

  /** Filtre anti-hallucination (véhicule/réservation cités doivent exister), borne et normalise. */
  private sanitizeProposals(
    raw: Array<Partial<AiAgendaProposalDto>> | undefined,
    validVeh: Set<string>,
    validResa: Set<string>,
    vehicles: VehRow[],
  ): AiAgendaProposalDto[] {
    const plateOf = new Map(vehicles.map((v) => [v.id, v.plate]));
    const kinds = new Set(['reassign', 'schedule_maintenance', 'mutualize', 'note']);
    return (Array.isArray(raw) ? raw : [])
      .filter((p): p is Partial<AiAgendaProposalDto> => !!p && kinds.has(String(p.kind)))
      .filter((p) => (!p.vehicleId || validVeh.has(p.vehicleId)) && (!p.reservationId || validResa.has(p.reservationId)))
      .filter((p) => p.kind !== 'reassign' || (!!p.reservationId && !!p.vehicleId)) // reassign exige les 2
      .slice(0, 15)
      .map((p) => ({
        id: randomUUID(),
        kind: p.kind as AiAgendaProposalDto['kind'],
        title: clip(p.title, 160) || 'Proposition',
        why: clip(p.why, 400),
        detail: clip(p.detail, 600) || null,
        reservationId: p.reservationId ?? null,
        vehicleId: p.vehicleId ?? null,
        vehiclePlate: p.vehicleId ? plateOf.get(p.vehicleId) ?? null : null,
        startAt: typeof p.startAt === 'string' ? p.startAt : null,
        endAt: typeof p.endAt === 'string' ? p.endAt : null,
        savingsEurPerMonth: typeof p.savingsEurPerMonth === 'number' && p.savingsEurPerMonth >= 0 ? Math.round(p.savingsEurPerMonth) : null,
        confidence: clamp01(p.confidence),
        status: 'pending' as const,
      }));
  }

  private trackRun(
    fleetId: string,
    origin: AgendaOptimizationOrigin,
    status: 'SUCCESS' | 'FAILURE',
    userId: string | null,
    meta: Record<string, unknown>,
  ): void {
    this.systemActivity.record({
      category: 'AI', action: 'agenda_optimization_run', status,
      actor: userId ? 'utilisateur' : 'planning', detail: `Analyse d'optimisation d'agenda (${origin})`,
      fleetId, triggeredByUserId: userId, meta,
    });
  }

  private async recordFailure(err: unknown, fleetId: string, userId?: string): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await this.errors.record(message, 'AI_OPTIMIZER', { fleetId, userId, capability: 'agenda_optimization' }, 'ERROR');
    } catch {
      /* la journalisation ne doit jamais casser la requête */
    }
  }

  // ─── Déclenchements automatiques ─────────────────────────────────────────

  /** Filet planifié : tourne chaque jour à 6h15, agit sur les flottes dues (daily/weekly). */
  @Cron('0 15 6 * * *')
  async runScheduled(): Promise<void> {
    try {
      const schedules = await this.prisma.agendaOptimizationSchedule.findMany({ where: { enabled: true } });
      const now = Date.now();
      for (const s of schedules) {
        const dueMs = (s.frequency === 'weekly' ? 7 : 1) * DAY_MS;
        if (s.lastRunAt && now - s.lastRunAt.getTime() < dueMs) continue;
        try {
          await this.runAnalysis(this.systemReader(s.fleetId), null, s.fleetId, 'scheduled');
        } catch (e) {
          this.logger.error(`runScheduled flotte ${s.fleetId}`, e as Error);
        }
        await this.prisma.agendaOptimizationSchedule.update({ where: { id: s.id }, data: { lastRunAt: new Date() } });
      }
    } catch (e) {
      this.logger.error('runScheduled failed', e as Error);
    }
  }

  /** Déclenchement événementiel (incident/maintenance ajouté) — best-effort, non bloquant. */
  async runForEvent(fleetId: string, origin: 'incident' | 'maintenance', trigger: string): Promise<void> {
    try {
      const s = await this.prisma.agendaOptimizationSchedule.findUnique({ where: { fleetId } });
      if (!s?.enabled) return;
      await this.runAnalysis(this.systemReader(fleetId), null, fleetId, origin, trigger);
    } catch (e) {
      this.logger.warn(`runForEvent ${origin} flotte ${fleetId} : ${(e as Error)?.message}`);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clip(s: unknown, max: number): string {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}
function clamp01(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function startOfWeekMonday(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (r.getDay() + 6) % 7;
  r.setDate(r.getDate() - offset);
  return r;
}

/** Numéro de semaine ISO 8601. */
function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
}
