import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AiProviderId, TripAiResultDto, TripAnalysisDto, TripNarrativeCompareDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { AiRouter } from '../ai/ai-router.service';
import { AiServiceError, type AiProvider } from '../ai/ai-client.types';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { TripAnalysisService } from './trip-analysis.service';
import { TRIP_NARRATIVE_SCHEMA, renderTripNarrativeSystem } from './trip-analysis.prompt';

type NarrativeOut = { narrative: string; advice: string; trustScore: number };

/**
 * Traçabilité fine (Palier 3) — couche LLM PAR-DESSUS l'analyse déterministe. Le LLM ne recalcule
 * rien : il transforme le résumé (chiffres fiables) en RÉCIT + « Tracky Trust Score » + CONSEILS éco.
 * Routé via AiRouter (Claude/GPT selon le switch, ou forcé pour le mode « Comparer »). Coût tracé.
 * Scoping anti-IDOR (accès véhicule). Best-effort : un échec IA remonte proprement (503 + centre d'alerte).
 */
@Injectable()
export class TripAnalysisLlmService {
  private readonly logger = new Logger(TripAnalysisLlmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly ai: AiRouter,
    private readonly aiUsage: AiUsageService,
    private readonly analysis: TripAnalysisService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /** Génère (ou régénère) le récit IA d'un trajet déjà analysé, le persiste, renvoie l'analyse enrichie. */
  async narrate(user: AuthUser, tripId: string, preferProvider?: AiProviderId): Promise<TripAnalysisDto> {
    const row = await this.load(user, tripId);
    const r = await this.run(row, preferProvider);
    await this.prisma.tripAnalysis.update({
      where: { tripId },
      data: { narrative: r.narrative, advice: r.advice, trustScore: r.trustScore, provider: r.provider },
    });
    const dto = await this.analysis.get(user, tripId);
    if (!dto) throw new NotFoundException('Trajet introuvable');
    return dto;
  }

  /** Mode « Comparer » : le MÊME trajet analysé par Claude ET GPT en parallèle, côte à côte. */
  async compare(user: AuthUser, tripId: string): Promise<TripNarrativeCompareDto> {
    const row = await this.load(user, tripId);
    const providers: AiProviderId[] = ['claude', 'gpt'];
    const results = await Promise.all(
      providers.map<Promise<TripAiResultDto>>(async (p) => {
        try {
          const r = await this.run(row, p);
          return { provider: p, model: r.model, narrative: r.narrative, advice: r.advice, trustScore: r.trustScore, costEur: r.costEur, latencyMs: r.latencyMs, error: null };
        } catch (e) {
          // Un moteur peut échouer (ex. GPT sans quota) sans casser la comparaison : on renvoie son erreur.
          const msg = e instanceof AiServiceError ? e.message : ((e as Error)?.message ?? 'Échec IA');
          return { provider: p, model: null, narrative: null, advice: null, trustScore: null, costEur: 0, latencyMs: null, error: msg };
        }
      }),
    );
    return { tripId, results };
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  private async load(user: AuthUser, tripId: string) {
    const row = await this.prisma.tripAnalysis.findUnique({ where: { tripId } });
    if (!row) throw new NotFoundException('Analyse introuvable — lancez d\'abord l\'analyse du trajet.');
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, row.vehicleId))) throw new NotFoundException('Trajet introuvable');
    return row;
  }

  /** Un appel LLM sur un trajet : construit le payload compact, appelle le moteur, trace le coût. */
  private async run(
    row: { tripId: string; fleetId: string; vehicleId: string; [k: string]: unknown },
    preferProvider?: AiProviderId,
  ): Promise<NarrativeOut & { provider: AiProvider; model: string; costEur: number; latencyMs: number }> {
    const payload = this.payload(row);
    let call;
    try {
      call = await this.ai.completeJson<NarrativeOut>(
        { system: renderTripNarrativeSystem(), userPayload: payload, schema: TRIP_NARRATIVE_SCHEMA, maxTokens: 1200 },
        { preferProvider },
      );
    } catch (e) {
      // Remonte au centre d'alerte (l'admin voit les pannes IA du récit de trajet).
      void this.errorLogger
        .record(e as Error, 'TRIP_ANALYSIS_AI', { fleetId: row.fleetId, vehicleId: row.vehicleId, tripId: row.tripId, provider: preferProvider })
        .catch(() => {});
      throw e;
    }
    // Coût tracé (action trip_analysis). Non bloquant.
    void this.aiUsage.record({
      userId: null, fleetId: row.fleetId, action: 'trip_analysis', model: call.model,
      inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
      cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
      latencyMs: call.latencyMs, ok: true,
    });
    const res = call.result ?? ({} as NarrativeOut);
    const costUsd = this.aiUsage.costOf(call.model, call.usage);
    return {
      provider: call.provider,
      model: call.model,
      narrative: typeof res.narrative === 'string' ? res.narrative.slice(0, 1500) : '',
      advice: typeof res.advice === 'string' ? res.advice.slice(0, 800) : '',
      trustScore: clampScore(res.trustScore),
      costEur: Math.round(costUsd * this.aiUsage.eurRate() * 10000) / 10000,
      latencyMs: call.latencyMs,
    };
  }

  /** Payload COMPACT (jamais les positions brutes) : le déterministe est déjà fait. */
  private payload(row: Record<string, unknown>) {
    const n = (k: string) => Number(row[k] ?? 0);
    const detail = (row.detail as { stops?: { durationMin: number }[]; speeding?: { maxSpeedKmh: number; limitKmh: number; overKmh: number; durationSec: number }[] }) ?? {};
    return {
      vehicle: { type: undefined, energy: undefined }, // enrichi si besoin ; le résumé suffit au récit
      summary: {
        distanceKm: n('distanceKm'),
        durationMin: Math.round(n('durationSec') / 60),
        movingMin: Math.round(n('movingSec') / 60),
        avgSpeedKmh: n('avgSpeedKmh'),
        maxSpeedKmh: n('maxSpeedKmh'),
        stopCount: n('stopCount'),
        idleMin: Math.round(n('idleSec') / 60),
      },
      gpsQuality: { points: n('gpsPoints'), validRatio: n('gpsValidRatio'), lostSignals: n('gpsLostCount') },
      speeding: {
        count: n('speedingCount'),
        durationSec: n('speedingSec'),
        maxOverKmh: n('maxOverKmh'),
        limitsKnown: !!row.limitsKnown,
        segments: (detail.speeding ?? []).slice(0, 8).map((s) => ({ maxSpeedKmh: s.maxSpeedKmh, limitKmh: s.limitKmh, overKmh: s.overKmh, durationSec: s.durationSec })),
      },
      ecoDriving: {
        harshAccel: n('harshAccel'), harshBrake: n('harshBrake'), ecoScore: n('ecoScore'),
        fuelLiters: row.fuelLiters ?? null, co2Kg: row.co2Kg ?? null,
      },
      stops: (detail.stops ?? []).slice(0, 12).map((s) => ({ durationMin: s.durationMin })),
    };
  }
}

function clampScore(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
}
