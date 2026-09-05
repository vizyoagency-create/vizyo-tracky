import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AiProviderId, TripAiResultDto, TripAnalysisDto, TripNarrativeCompareDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import { AiRouter } from '../ai/ai-router.service';
import { AiServiceError, classerEchecIa, type AiProvider, type AiProviderMode } from '../ai/ai-client.types';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { TripAnalysisService } from './trip-analysis.service';
import { TRIP_NARRATIVE_SCHEMA, renderTripNarrativeSystem, renderTripSynthesisSystem } from './trip-analysis.prompt';
// Module PUR, partage avec l'agent sur poste : le payload et l'assainissement ne doivent exister
// qu'a UN endroit. Deux copies finiraient par ecrire des recits differents selon l'auteur.
import { assainirRecit, construirePayloadRecit, type LigneAnalyse } from './trip-narrative.shared';

type NarrativeOut = { narrative: string; advice: string; trustScore: number };
type RunResult = NarrativeOut & { provider: AiProviderMode; model: string; costEur: number; latencyMs: number };
/** Ligne d'analyse chargée (indexable pour le payload compact). */
type TripAnalysisRow = Record<string, unknown> & { tripId: string; fleetId: string; vehicleId: string };

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
    private readonly aiAvail: AiAvailabilityService,
    private readonly aiUsage: AiUsageService,
    private readonly analysis: TripAnalysisService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /** Interrupteur maître : l'IA doit être configurée ET non désactivée par la flotte du trajet. */
  private async ensureAiEnabled(fleetId: string): Promise<void> {
    if (!(await this.aiAvail.isEnabledForFleet(fleetId, 'tripAnalysis'))) {
      throw new ForbiddenException('Assistance IA désactivée pour cette flotte.');
    }
  }

  /**
   * Génère (ou régénère) le récit IA d'un trajet déjà analysé, le persiste, renvoie l'analyse enrichie.
   * Si aucun moteur n'est forcé ET que le MODE global est « mixte » (les 2), on lance l'ENSEMBLE
   * (les 2 moteurs + un agent de synthèse). Sinon un seul moteur (celui du switch ou forcé).
   */
  async narrate(user: AuthUser, tripId: string, preferProvider?: AiProviderId): Promise<TripAnalysisDto> {
    const row = await this.load(user, tripId);
    await this.ensureAiEnabled(row.fleetId);
    const useMixte = !preferProvider && (await this.ai.mode()) === 'both' && this.ai.mixteAvailable();
    const r = useMixte ? await this.runEnsemble(row, user.id) : await this.run(row, user.id, preferProvider);
    await this.prisma.tripAnalysis.update({
      where: { tripId },
      // `narratedAt` : date du TEXTE. Un recalcul ultérieur remplacera les chiffres sans y
      // toucher, et l'écran pourra dire que le récit décrit un état antérieur.
      data: { narrative: r.narrative, advice: r.advice, trustScore: r.trustScore, provider: r.provider, narratedAt: new Date() },
    });
    const dto = await this.analysis.get(user, tripId);
    if (!dto) throw new NotFoundException('Trajet introuvable');
    return dto;
  }

  /**
   * MIXTE — les 2 moteurs analysent le trajet en parallèle, puis un agent de SYNTHÈSE (Claude) combine
   * le meilleur des deux + corrige vs les données. Si un moteur échoue (ex. GPT sans quota), on retombe
   * proprement sur celui qui a réussi (pas de synthèse superflue). `provider` final = 'both'.
   */
  /**
   * @param actorId QUI declenche. Trace dans `AiUsageLog` — sans lui, la depense
   *                apparait chez le client sans acteur identifiable (« action fantome »).
   */
  private async runEnsemble(row: TripAnalysisRow, actorId: string): Promise<RunResult> {
    const settled = await Promise.allSettled([this.run(row, actorId, 'claude'), this.run(row, actorId, 'gpt')]);
    const ok = settled.filter((s): s is PromiseFulfilledResult<RunResult> => s.status === 'fulfilled').map((s) => s.value);
    if (ok.length === 0) {
      // Les 2 ont échoué : remonte la 1re erreur (déjà journalisée par run()).
      const err = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      throw err ? err.reason : new Error('Échec IA (mixte)');
    }
    if (ok.length === 1) return { ...ok[0], provider: 'both' }; // un seul moteur dispo → pas de synthèse
    const synth = await this.synthesize(row, actorId, ok[0], ok[1]);
    // Coût du mixte = somme (les 2 analyses + la synthèse).
    return { ...synth, provider: 'both', costEur: round4(ok[0].costEur + ok[1].costEur + synth.costEur) };
  }

  /** Agent de synthèse : combine 2 analyses en une finale (Claude). Récit homogène, sans marque. */
  private async synthesize(row: TripAnalysisRow, actorId: string, a: RunResult, b: RunResult): Promise<RunResult> {
    const payload = {
      donnees: construirePayloadRecit(row as unknown as LigneAnalyse),
      analyses: [
        { source: 'A', narrative: a.narrative, advice: a.advice, trustScore: a.trustScore },
        { source: 'B', narrative: b.narrative, advice: b.advice, trustScore: b.trustScore },
      ],
    };
    let call;
    try {
      call = await this.ai.completeJson<NarrativeOut>(
        { system: renderTripSynthesisSystem(), userPayload: payload, schema: TRIP_NARRATIVE_SCHEMA, maxTokens: 1200, effort: 'low' },
        { preferProvider: 'claude', trace: { action: 'trip_analysis', userId: actorId, fleetId: row.fleetId } },
      );
    } catch (e) {
      // Niveau décidé par la couche IA + motif du fournisseur en contexte (C3 point 5).
      const { niveau, kind, motifFournisseur } = classerEchecIa(e);
      void this.errorLogger
        .record(e as Error, 'TRIP_ANALYSIS_AI', { fleetId: row.fleetId, vehicleId: row.vehicleId, tripId: row.tripId, phase: 'synthese-mixte', kind, motifFournisseur }, niveau)
        .catch(() => {});
      throw e;
    }
    void this.aiUsage.record({
      // ⚠️ `userId` valait `null` : la depense s'inscrivait chez le client SANS acteur.
      // Un super-admin analysant le trajet d'une societe y laissait une ligne de cout que
      // personne ne pouvait rattacher a une action — invisible a expliquer au client.
      userId: actorId, fleetId: row.fleetId, action: 'trip_analysis', model: call.model, provider: call.provider,
      inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
      cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
      latencyMs: call.latencyMs, ok: true,
    });
    return {
      provider: call.provider, model: call.model,
      ...assainirRecit(call.result),
      costEur: round4(this.aiUsage.costOf(call.model, call.usage) * this.aiUsage.eurRate()),
      latencyMs: call.latencyMs,
    };
  }

  /** Mode « Comparer » : le MÊME trajet analysé par Claude ET GPT en parallèle, côte à côte. */
  async compare(user: AuthUser, tripId: string): Promise<TripNarrativeCompareDto> {
    const row = await this.load(user, tripId);
    await this.ensureAiEnabled(row.fleetId);
    const providers: AiProviderId[] = ['claude', 'gpt'];
    const results = await Promise.all(
      providers.map<Promise<TripAiResultDto>>(async (p) => {
        try {
          const r = await this.run(row, user.id, p);
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

  private async load(user: AuthUser, tripId: string): Promise<TripAnalysisRow> {
    const row = await this.prisma.tripAnalysis.findUnique({ where: { tripId } });
    if (!row) throw new NotFoundException('Analyse introuvable — lancez d\'abord l\'analyse du trajet.');
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, row.vehicleId))) throw new NotFoundException('Trajet introuvable');
    return row as unknown as TripAnalysisRow;
  }

  /** Un appel LLM sur un trajet : construit le payload compact, appelle le moteur, trace le coût. */
  private async run(row: TripAnalysisRow, actorId: string, preferProvider?: AiProviderId): Promise<RunResult> {
    const payload = construirePayloadRecit(row as unknown as LigneAnalyse);
    let call;
    try {
      call = await this.ai.completeJson<NarrativeOut>(
        { system: renderTripNarrativeSystem(), userPayload: payload, schema: TRIP_NARRATIVE_SCHEMA, maxTokens: 1200, effort: 'low' },
        { preferProvider, trace: { action: 'trip_analysis', userId: actorId, fleetId: row.fleetId } },
      );
    } catch (e) {
      // Remonte au centre d'alerte (l'admin voit les pannes IA du récit de trajet), avec le
      // niveau décidé par la couche IA et le motif du fournisseur en contexte (C3 point 5).
      const { niveau, kind, motifFournisseur } = classerEchecIa(e);
      void this.errorLogger
        .record(e as Error, 'TRIP_ANALYSIS_AI', { fleetId: row.fleetId, vehicleId: row.vehicleId, tripId: row.tripId, provider: preferProvider, kind, motifFournisseur }, niveau)
        .catch(() => {});
      throw e;
    }
    // Coût tracé (action trip_analysis). Non bloquant.
    void this.aiUsage.record({
      // ⚠️ `userId` valait `null` : la depense s'inscrivait chez le client SANS acteur.
      // Un super-admin analysant le trajet d'une societe y laissait une ligne de cout que
      // personne ne pouvait rattacher a une action — invisible a expliquer au client.
      userId: actorId, fleetId: row.fleetId, action: 'trip_analysis', model: call.model, provider: call.provider,
      inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
      cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
      latencyMs: call.latencyMs, ok: true,
    });
    return {
      provider: call.provider,
      model: call.model,
      ...assainirRecit(call.result),
      costEur: round4(this.aiUsage.costOf(call.model, call.usage) * this.aiUsage.eurRate()),
      latencyMs: call.latencyMs,
    };
  }

}

function round4(v: number): number { return Math.round(v * 10000) / 10000; }
