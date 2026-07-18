import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, UserRole, type TripAutomationRun, type TripAutomationSettings } from '@prisma/client';
import type {
  SetTripAutomationSettingsDto,
  TripAutomationRunDto,
  TripAutomationRunItemDto,
  TripAutomationRunStats,
  TripAutomationSettingsDto,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { TripsService } from '../trips/trips.service';
import { TripAnalysisLlmService } from './trip-analysis-llm.service';
import { TripAnalysisService } from './trip-analysis.service';

/** Source des erreurs de l'automatisation dans le centre d'alerte (filtre dédié). */
const SOURCE = 'TRIP_AUTOMATION';
/** recompute() clampe déjà `to` à now-10min ; on aligne la fenêtre dessus. */
const RECOMPUTE_TAIL_MS = 10 * 60 * 1000;
/** Marge amont quand on recompute le « tail sale » (rattrape un trajet frontière). */
const RECOMPUTE_BACKOFF_MS = 30 * 60 * 1000;
/** Plafond dur de trajets listés par véhicule et par run (défense mémoire). */
const MAX_TRIPS_PER_VEHICLE = 500;
/** Détail borné stocké par run (les trajets traités, cliquables). */
const MAX_ITEMS_PER_RUN = 300;
/** Historique conservé (runs récents) — le reste est élagué à chaque insertion. */
const KEEP_RUNS = 100;

type MutableStats = {
  fleets: number;
  vehicles: number;
  recomputed: number;
  analyzed: number;
  narrated: number;
  failed: number;
};

type RunItem = TripAutomationRunItemDto;

/**
 * Automatisation des trajets (2026-07) — un cron HORAIRE qui, pour TOUTES les flottes, exécute le
 * pipeline « recalcul → analyse déterministe → récit IA », de façon bornée et paramétrable
 * (singleton `TripAutomationSettings`, piloté par le super-admin).
 *
 * Ordre IMPOSÉ (le recompute re-crée les trajets avec de NOUVEAUX ids et orpheline les analyses) :
 *   1. RECALCUL (optionnel) — on ne recompute QUE le « tail sale » (trajets non issus d'un précédent
 *      recompute) pour éviter de re-miner (donc ré-analyser + ré-narrer) les trajets déjà propres.
 *      C'est le « if avant pour clear les trajets » : on analyse 3 vrais trajets, pas 10 fragments.
 *   2. ANALYSE déterministe (jamais bloquée par l'IA — c'est la couche non-IA).
 *   3. RÉCIT IA, seulement si l'IA est active pour la flotte, borné par un cap de coût.
 *
 * CONTRÔLE : chaque passage est PERSISTÉ (TripAutomationRun) avec quand / pour qui / quoi + la liste
 * cliquable des trajets traités. Robustesse : verrou anti-chevauchement, tout est séquentiel
 * (throttle OSM/Overpass partagé + VPS 2 vCPU), chaque échec → centre d'alerte (jamais de throw).
 */
@Injectable()
export class TripAutomationService {
  private readonly logger = new Logger(TripAutomationService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly analysis: TripAnalysisService,
    private readonly llm: TripAnalysisLlmService,
    private readonly aiAvail: AiAvailabilityService,
    private readonly errorLogger: ErrorLogger,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /** Toutes les heures à HH:45 (décalé des crons agenda :00 / rapports :20 pour lisser le VPS). */
  @Cron('0 45 * * * *')
  async runScheduled(): Promise<void> {
    let settings: TripAutomationSettings;
    try {
      settings = await this.loadRow();
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'settings' }, 'CRITICAL');
      return;
    }
    if (!settings.enabled) return;

    const parisHour = this.parisHour();
    if (settings.frequency === 'daily') {
      if (parisHour !== settings.hour) return;
      // Anti double-run quotidien (marge 22h).
      if (settings.lastRunAt && Date.now() - settings.lastRunAt.getTime() < 22 * 3600 * 1000) return;
    } else {
      // Horaire : garde anti double-run rapproché (< 50 min).
      if (settings.lastRunAt && Date.now() - settings.lastRunAt.getTime() < 50 * 60 * 1000) return;
    }

    await this.run(settings, 'scheduled');
  }

  /** Lancement MANUEL (bouton « Lancer maintenant » super-admin) — ignore cadence/heure. */
  async runNow(): Promise<TripAutomationRunStats> {
    const settings = await this.loadRow();
    return this.run(settings, 'manual');
  }

  private async run(settings: TripAutomationSettings, origin: 'scheduled' | 'manual'): Promise<TripAutomationRunStats> {
    if (this.running) {
      this.logger.warn('Run déjà en cours — skip.');
      return this.finalStats(this.emptyStats(), 0);
    }
    this.running = true;
    const startedAt = new Date();
    const startMs = Date.now();
    const stats = this.emptyStats();
    const items: RunItem[] = [];
    try {
      const user = this.systemUser();
      const now = Date.now();
      const windowFrom = new Date(now - settings.lookbackHours * 3600 * 1000);
      const windowTo = new Date(now - RECOMPUTE_TAIL_MS);

      const fleets = await this.prisma.fleet.findMany({ select: { id: true, name: true } });
      for (const fleet of fleets) {
        stats.fleets++;
        const aiOn = settings.narrateEnabled && (await this.aiAvail.isEnabledForFleet(fleet.id, 'tripAnalysis'));

        let vehicles: { id: string; plate: string }[];
        try {
          vehicles = await this.prisma.vehicle.findMany({
            where: { fleetId: fleet.id, tracker: { isNot: null } },
            select: { id: true, plate: true },
          });
        } catch (e) {
          stats.failed++;
          await this.errorLogger.record(e as Error, SOURCE, { fleetId: fleet.id, phase: 'vehicles' });
          continue;
        }

        for (const v of vehicles) {
          // Arrêt anticipé si les deux caps sont atteints (rien de plus à faire ce run).
          const analysisCapReached = stats.analyzed >= settings.maxAnalysesPerRun;
          const narrationCapReached = !aiOn || stats.narrated >= settings.maxNarrationsPerRun;
          if (analysisCapReached && narrationCapReached) break;
          stats.vehicles++;
          await this.processVehicle(
            user, { id: v.id, plate: v.plate, fleetId: fleet.id, fleetName: fleet.name },
            aiOn, windowFrom, windowTo, settings, stats, items,
          );
        }
      }

      const runStats = this.finalStats(stats, Date.now() - startMs);
      await this.persistRun(settings.id, runStats);
      await this.recordRun(origin, startedAt, runStats, items);
      this.systemActivity.record({
        category: 'AI',
        action: 'trip_automation_run',
        status: stats.failed > 0 ? 'FAILURE' : 'SUCCESS',
        actor: origin === 'manual' ? 'super-admin' : 'planning',
        detail:
          `Automatisation trajets (${origin}) : ${stats.recomputed} recalculé(s) · ${stats.analyzed} analysé(s) · ` +
          `${stats.narrated} récit(s) IA · ${stats.failed} échec(s) sur ${stats.fleets} flotte(s).`,
        meta: runStats as unknown as Record<string, unknown>,
      });
      return runStats;
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'run' }, 'CRITICAL');
      return this.finalStats(stats, Date.now() - startMs);
    } finally {
      this.running = false;
    }
  }

  private async processVehicle(
    user: AuthUser,
    veh: { id: string; plate: string; fleetId: string; fleetName: string | null },
    aiOn: boolean,
    windowFrom: Date,
    windowTo: Date,
    settings: TripAutomationSettings,
    stats: MutableStats,
    items: RunItem[],
  ): Promise<void> {
    const { id: vehicleId, fleetId } = veh;

    // 1) RECALCUL « if avant pour clear les trajets » — uniquement le tail sale.
    if (settings.recomputeTrips) {
      try {
        const dirty = await this.prisma.trip.findFirst({
          where: {
            vehicleId,
            endedAt: { not: null },
            startedAt: { gte: windowFrom },
            // segmentationSource est non-nullable (défaut 'live') : « sale » = pas encore recomputé.
            segmentationSource: { not: 'recompute' },
          },
          select: { startedAt: true },
          orderBy: { startedAt: 'asc' },
        });
        if (dirty) {
          const fromMs = Math.max(windowFrom.getTime(), dirty.startedAt.getTime() - RECOMPUTE_BACKOFF_MS);
          const r = await this.trips.recompute(
            { userId: user.id, role: user.role, fleetId: user.fleetId },
            { vehicleId, from: new Date(fromMs).toISOString(), to: windowTo.toISOString() },
          );
          stats.recomputed += r.created;
        }
      } catch (e) {
        stats.failed++;
        await this.errorLogger.record(e as Error, SOURCE, { fleetId, vehicleId, phase: 'recompute' });
      }
    }

    // 2) Trajets clôturés de la fenêtre + état analyse/récit.
    let trips: { id: string; startedAt: Date }[];
    try {
      trips = await this.prisma.trip.findMany({
        where: { vehicleId, endedAt: { not: null }, startedAt: { gte: windowFrom } },
        select: { id: true, startedAt: true },
        orderBy: { startedAt: 'desc' },
        take: MAX_TRIPS_PER_VEHICLE,
      });
    } catch (e) {
      stats.failed++;
      await this.errorLogger.record(e as Error, SOURCE, { fleetId, vehicleId, phase: 'listTrips' });
      return;
    }
    if (trips.length === 0) return;

    let existing: { tripId: string; narrative: string | null }[];
    try {
      existing = await this.prisma.tripAnalysis.findMany({
        where: { tripId: { in: trips.map((t) => t.id) } },
        select: { tripId: true, narrative: true },
      });
    } catch (e) {
      stats.failed++;
      await this.errorLogger.record(e as Error, SOURCE, { fleetId, vehicleId, phase: 'existing' });
      return;
    }
    // tripId -> a une analyse ? (valeur = a un récit ?)
    const narrativeByTrip = new Map(existing.map((e) => [e.tripId, !!e.narrative]));

    for (const t of trips) {
      const hasAnalysis = narrativeByTrip.has(t.id);
      let hasNarrative = narrativeByTrip.get(t.id) ?? false;
      let didAnalyze = false;
      let didNarrate = false;

      // 2a) ANALYSE déterministe si absente (couche non-IA, jamais coupée).
      if (!hasAnalysis) {
        if (stats.analyzed >= settings.maxAnalysesPerRun) continue; // cap → ni analyse ni récit
        try {
          await this.analysis.analyze(user, t.id);
          stats.analyzed++;
          didAnalyze = true;
          hasNarrative = false; // désormais analysé, sans récit
        } catch (e) {
          stats.failed++;
          await this.errorLogger.record(e as Error, SOURCE, { fleetId, vehicleId, tripId: t.id, phase: 'analyze' });
          continue; // pas d'analyse → pas de récit possible
        }
      }

      // 2b) RÉCIT IA si active + pas déjà de récit + budget restant.
      if (aiOn && !hasNarrative && stats.narrated < settings.maxNarrationsPerRun) {
        try {
          await this.llm.narrate(user, t.id);
          stats.narrated++;
          didNarrate = true;
        } catch (e) {
          stats.failed++;
          await this.errorLogger.record(e as Error, SOURCE, { fleetId, vehicleId, tripId: t.id, phase: 'narrate' });
        }
      }

      // Trace cliquable : un trajet réellement touché ce run (analyse et/ou récit).
      if ((didAnalyze || didNarrate) && items.length < MAX_ITEMS_PER_RUN) {
        items.push({
          fleetId, fleetName: veh.fleetName,
          vehicleId, plate: veh.plate,
          tripId: t.id, tripStartedAt: t.startedAt.toISOString(),
          action: didNarrate ? 'narrated' : 'analyzed',
        });
      }
    }
  }

  // ── Réglages (singleton) ────────────────────────────────────────────────

  async getSettings(): Promise<TripAutomationSettingsDto> {
    return this.toDto(await this.loadRow());
  }

  async setSettings(dto: SetTripAutomationSettingsDto, userId: string | null): Promise<TripAutomationSettingsDto> {
    const row = await this.loadRow();
    const data: Prisma.TripAutomationSettingsUpdateInput = { updatedByUserId: userId };
    if (dto.enabled !== undefined) data.enabled = !!dto.enabled;
    if (dto.frequency !== undefined) data.frequency = dto.frequency === 'daily' ? 'daily' : 'hourly';
    if (dto.hour !== undefined) data.hour = this.clampInt(dto.hour, 0, 23);
    if (dto.lookbackHours !== undefined) data.lookbackHours = this.clampInt(dto.lookbackHours, 1, 720);
    if (dto.recomputeTrips !== undefined) data.recomputeTrips = !!dto.recomputeTrips;
    if (dto.narrateEnabled !== undefined) data.narrateEnabled = !!dto.narrateEnabled;
    if (dto.maxAnalysesPerRun !== undefined) data.maxAnalysesPerRun = this.clampInt(dto.maxAnalysesPerRun, 0, 5000);
    if (dto.maxNarrationsPerRun !== undefined) data.maxNarrationsPerRun = this.clampInt(dto.maxNarrationsPerRun, 0, 2000);
    const updated = await this.prisma.tripAutomationSettings.update({ where: { id: row.id }, data });
    return this.toDto(updated);
  }

  /** Historique des passages (le plus récent d'abord) — audit « quand / pour qui / quoi ». */
  async listRuns(limit = 30): Promise<TripAutomationRunDto[]> {
    const take = this.clampInt(limit, 1, 100);
    const rows = await this.prisma.tripAutomationRun.findMany({ orderBy: { startedAt: 'desc' }, take });
    return rows.map((r) => this.runToDto(r));
  }

  private async loadRow(): Promise<TripAutomationSettings> {
    const existing = await this.prisma.tripAutomationSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (existing) return existing;
    return this.prisma.tripAutomationSettings.create({ data: {} });
  }

  private async persistRun(id: string, runStats: TripAutomationRunStats): Promise<void> {
    try {
      await this.prisma.tripAutomationSettings.update({
        where: { id },
        data: { lastRunAt: new Date(), lastRunStats: runStats as unknown as Prisma.InputJsonValue },
      });
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'persistRun' });
    }
  }

  /** Enregistre le run dans l'historique (audit + récits cliquables) puis élague les vieux. */
  private async recordRun(
    origin: 'scheduled' | 'manual',
    startedAt: Date,
    runStats: TripAutomationRunStats,
    items: RunItem[],
  ): Promise<void> {
    try {
      await this.prisma.tripAutomationRun.create({
        data: {
          startedAt,
          finishedAt: new Date(),
          origin,
          fleets: runStats.fleets,
          vehicles: runStats.vehicles,
          recomputed: runStats.recomputed,
          analyzed: runStats.analyzed,
          narrated: runStats.narrated,
          failed: runStats.failed,
          durationMs: runStats.durationMs,
          items: items.slice(0, MAX_ITEMS_PER_RUN) as unknown as Prisma.InputJsonValue,
        },
      });
      // Élagage best-effort : ne garder que les KEEP_RUNS plus récents.
      const stale = await this.prisma.tripAutomationRun.findMany({
        orderBy: { startedAt: 'desc' },
        skip: KEEP_RUNS,
        select: { id: true },
      });
      if (stale.length > 0) {
        await this.prisma.tripAutomationRun.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
      }
    } catch (e) {
      await this.errorLogger.record(e as Error, SOURCE, { phase: 'recordRun' });
    }
  }

  private toDto(r: TripAutomationSettings): TripAutomationSettingsDto {
    return {
      enabled: r.enabled,
      frequency: r.frequency === 'daily' ? 'daily' : 'hourly',
      hour: r.hour,
      lookbackHours: r.lookbackHours,
      recomputeTrips: r.recomputeTrips,
      narrateEnabled: r.narrateEnabled,
      maxAnalysesPerRun: r.maxAnalysesPerRun,
      maxNarrationsPerRun: r.maxNarrationsPerRun,
      lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
      lastRunStats: (r.lastRunStats as unknown as TripAutomationRunStats | null) ?? null,
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    };
  }

  private runToDto(r: TripAutomationRun): TripAutomationRunDto {
    const items = Array.isArray(r.items) ? (r.items as unknown as TripAutomationRunItemDto[]) : [];
    return {
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      origin: r.origin === 'manual' ? 'manual' : 'scheduled',
      fleets: r.fleets,
      vehicles: r.vehicles,
      recomputed: r.recomputed,
      analyzed: r.analyzed,
      narrated: r.narrated,
      failed: r.failed,
      durationMs: r.durationMs,
      items,
    };
  }

  // ── Utilitaires ─────────────────────────────────────────────────────────

  /** Super-admin SYNTHÉTIQUE : court-circuite les checks d'accès (aucune requête sur l'id). */
  private systemUser(): AuthUser {
    return {
      id: 'system-trip-automation',
      authUserId: 'system-trip-automation',
      email: 'system@tracky',
      firstName: null,
      lastName: null,
      role: UserRole.SUPER_ADMIN,
      isOwner: false,
      fleetId: null,
      isActive: true,
      permissions: null,
    };
  }

  /** Heure courante à Paris (0-23), robuste au DST via Intl. */
  private parisHour(): number {
    try {
      const s = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Paris',
        hour: '2-digit',
        hour12: false,
      }).format(new Date());
      const h = parseInt(s, 10);
      return Number.isFinite(h) ? h % 24 : new Date().getHours();
    } catch {
      return new Date().getHours();
    }
  }

  private clampInt(n: number, min: number, max: number): number {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  private emptyStats(): MutableStats {
    return { fleets: 0, vehicles: 0, recomputed: 0, analyzed: 0, narrated: 0, failed: 0 };
  }

  private finalStats(s: MutableStats, durationMs: number): TripAutomationRunStats {
    return { ...s, durationMs, at: new Date().toISOString() };
  }
}
