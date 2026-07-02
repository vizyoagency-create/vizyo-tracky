import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import {
  effectiveBlockingEndMs,
  estimateCostPerKm,
  isImmobilizingEvent,
  type AgendaOptimizationDashboardDto,
  type AgendaOptimizationScheduleDto,
  type AgendaReportStatus,
  type AiAgendaProposalDto,
  type AgendaOptimizationReportDto,
  type ForecastWeekBucketDto,
  type OptimizationOpportunityDto,
  type SetAgendaOptimizationScheduleDto,
  type VehicleEventDto,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { ForecastService } from './forecast.service';
import { FleetInsightsService } from './fleet-insights.service';
import { VehicleEventsService } from './vehicle-events.service';

const DAY_MS = 24 * 60 * 60 * 1000;
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
  ) {}

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

    const [forecastRes, allEvents, utilization, latestReport, schedule] = await Promise.all([
      this.forecast.getForecast(user, from, to),
      this.events.list(user, { from, to }),
      this.insights.getUtilization(user, utilFrom, from),
      this.loadLatestReport(fid),
      this.getSchedule(user, fid),
    ]);

    // Restreint tout au périmètre véhicule de la flotte cible (cas super-admin multi-flottes).
    const events = allEvents.filter((e) => vehicleIds.has(e.vehicleId));
    const forecastSlots = forecastRes.slots.filter((s) => vehicleIds.has(s.vehicleId));
    const utilVehicles = utilization.vehicles.filter((v) => vehicleIds.has(v.vehicleId));

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
}

// ─── Helpers date (heure locale) ───────────────────────────────────────────

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
