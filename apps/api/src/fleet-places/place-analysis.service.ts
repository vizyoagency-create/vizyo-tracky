import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { FleetPlaceKind } from '@prisma/client';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import { AiRouter } from '../ai/ai-router.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import type { AuthUser } from '../auth/types/auth-user';
import { distanceMeters } from '../common/utils/haversine';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { FleetPlacesService } from './fleet-places.service';
import { PlaceEnrichmentService, type PlaceFacts } from './place-enrichment.service';

/** Bornes de sécurité sur ce que renvoie le LLM (on ne fait jamais confiance à une sortie modèle). */
const MAX_SUMMARY = 700;
const MAX_ITEM = 220;
const MAX_ITEMS = 6;

/** Sortie attendue du modèle (Structured Outputs). */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'highlights', 'recommendations'],
  properties: {
    summary: { type: 'string', description: 'Synthèse du lieu en 2 à 3 phrases.' },
    highlights: {
      type: 'array',
      items: { type: 'string' },
      description: 'Points clés FACTUELS (horaires, services, fréquentation, prix).',
    },
    recommendations: {
      type: 'array',
      items: { type: 'string' },
      description: "Actions concrètes pour l'exploitant de la flotte.",
    },
  },
} as const;

const SYSTEM = [
  "Tu es un assistant d'exploitation de flotte de véhicules. On te fournit des FAITS VÉRIFIÉS sur un",
  'lieu (données OpenStreetMap + statistiques réelles d’usage de la flotte). Tu produis une fiche',
  'courte et utile à un gestionnaire de flotte.',
  '',
  'RÈGLES ABSOLUES :',
  "- N'invente AUCUNE information. Utilise UNIQUEMENT les faits fournis.",
  "- Si une donnée est absente, ne la mentionne pas et ne la suppose pas. Ne dis pas non plus qu'elle manque.",
  "- Ne cite jamais d'horaires, prix, services, notes ou coordonnées absents des faits.",
  '- Pas de superlatif commercial, pas de remplissage. Si les faits sont maigres, sois bref.',
  '- Écris en français, ton professionnel, phrases courtes.',
].join('\n');

/**
 * Analyse IA d'un lieu clé.
 *
 * PRINCIPE : l'IA ne collecte RIEN. Les faits viennent d'OpenStreetMap (gratuit, vérifiable) et des
 * données réelles de la flotte (passages, véhicules, prix relevés). Le modèle ne fait que les
 * REFORMULER en fiche exploitable. Les faits sources sont figés dans `PlaceAnalysis.facts` pour
 * pouvoir vérifier a posteriori d'où sort chaque affirmation.
 *
 * CONTRÔLE IA (dans cet ordre, avant tout appel payant) :
 *   1. permission `places_analyze` — appliquée par le controller ;
 *   2. `AiAvailabilityService.isEnabledForFleet(fleetId, 'placeAnalysis')` — porte CANONIQUE qui
 *      cumule clé provider + kill-switch global + `Fleet.aiEnabled` (lui-même piloté par
 *      l'abonnement Stripe). On ne duplique JAMAIS ces vérifications ici : elles divergeraient.
 *   3. `aiUsage.record(...)` après CHAQUE appel — sinon le coût serait invisible au tableau de bord.
 */
@Injectable()
export class PlaceAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly places: FleetPlacesService,
    private readonly enrichment: PlaceEnrichmentService,
    private readonly aiAvail: AiAvailabilityService,
    private readonly ai: AiRouter,
    private readonly aiUsage: AiUsageService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /**
   * L'analyse IA est-elle proposable pour cette société ? Sert à MASQUER le bouton côté UI :
   * l'utilisateur ne doit pas voir une action qu'il ne peut pas déclencher.
   */
  async isAvailable(fleetId: string | null | undefined): Promise<boolean> {
    return this.aiAvail.isEnabledForFleet(fleetId, 'placeAnalysis');
  }

  /** Analyse courante d'un lieu (null si jamais analysé). Lecture seule, aucun appel IA. */
  async get(user: AuthUser, placeId: string): Promise<PlaceAnalysisDto | null> {
    const place = await this.places.findScoped(user, placeId);
    const row = await this.prisma.placeAnalysis.findUnique({ where: { placeId: place.id } });
    return row ? toDto(row) : null;
  }

  /** Lance (ou relance) l'analyse IA d'un lieu. Remplace l'analyse courante. */
  async analyze(
    user: AuthUser,
    placeId: string,
    origin: 'manual' | 'scheduled' = 'manual',
  ): Promise<PlaceAnalysisDto> {
    const place = await this.places.findScoped(user, placeId);

    // ── Porte IA canonique. Refus EXPLICITE (pas de dégradation silencieuse) : l'appelant doit
    // savoir que l'IA est coupée, et l'UI ne doit de toute façon pas proposer le bouton.
    if (!(await this.aiAvail.isEnabledForFleet(place.fleetId, 'placeAnalysis'))) {
      throw new ServiceUnavailableException(
        "L'assistance IA est désactivée pour cette société (ou l'analyse de lieu est coupée globalement).",
      );
    }

    // ── Faits : OSM (best-effort) + usage réel de la flotte sur ce lieu.
    const osm = await this.enrichment.enrich(place.lat, place.lng, place.kind);
    const usage = await this.usageFacts(place);
    const facts = {
      lieu: {
        nom: place.name,
        nature: kindLabel(place.kind),
        rayonM: Math.round(place.radiusM),
        note: place.note ?? undefined,
      },
      openStreetMap: osm ?? undefined,
      usageFlotte: usage,
    };

    // ── Appel IA.
    let res;
    try {
      res = await this.ai.completeJson<LlmOut>({
        system: SYSTEM,
        userPayload: facts,
        schema: SCHEMA,
        maxTokens: 900,
      });
    } catch (err) {
      // Panne/refus du provider : visible au centre d'alerte, et l'erreur typée (503) remonte à l'UI.
      this.errorLogger.recordBackground(
        err instanceof Error ? err : new Error(String(err)),
        'place-analysis',
        { placeId: place.id, fleetId: place.fleetId, note: "echec de l'appel IA d'analyse de lieu" },
      );
      throw err;
    }

    // ── Coût : OBLIGATOIRE après chaque appel, sinon il n'apparaît pas dans « Coûts IA ».
    void this.aiUsage.record({
      userId: origin === 'manual' ? user.id : null,
      fleetId: place.fleetId,
      model: res.model,
      action: 'place_analysis',
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheWriteTokens: res.usage.cacheWriteTokens,
      cacheReadTokens: res.usage.cacheReadTokens,
      latencyMs: res.latencyMs,
      ok: true,
    });

    // ── Persistance (sortie modèle bornée : jamais de confiance aveugle).
    const summary = clamp(res.result?.summary, MAX_SUMMARY);
    const highlights = clampList(res.result?.highlights);
    const recommendations = clampList(res.result?.recommendations);
    // costOf() renvoie des USD → conversion au taux courant (même formule que l'optimiseur IA).
    const costEur = Math.round(this.aiUsage.costOf(res.model, res.usage) * this.aiUsage.eurRate() * 10000) / 10000;

    const row = await this.prisma.placeAnalysis.upsert({
      where: { placeId: place.id },
      create: {
        placeId: place.id,
        fleetId: place.fleetId,
        facts: facts as object,
        summary,
        highlights,
        recommendations,
        aiProvider: res.provider,
        aiModel: res.model,
        costEur,
        origin,
        computedByUserId: origin === 'manual' ? user.id : null,
      },
      update: {
        facts: facts as object,
        summary,
        highlights,
        recommendations,
        aiProvider: res.provider,
        aiModel: res.model,
        costEur,
        origin,
        computedByUserId: origin === 'manual' ? user.id : null,
        computedAt: new Date(),
      },
    });
    return toDto(row);
  }

  /**
   * Usage RÉEL du lieu par la flotte — c'est ce qui rend l'analyse utile (l'IA seule ne saurait rien
   * de tes véhicules). Station : passages + véhicules + prix relevés. Parking/dépôt : zones mortes
   * GPS rattachées, c'est-à-dire les véhicules qui y perdent le signal (stationnement couvert).
   */
  private async usageFacts(place: {
    id: string; fleetId: string; kind: FleetPlaceKind; lat: number; lng: number; radiusM: number; stationId: string | null;
  }): Promise<Record<string, unknown>> {
    if (place.stationId) {
      const stops = await this.prisma.tripFuelStop.findMany({
        where: { fleetId: place.fleetId, stationId: place.stationId },
        select: { vehicleId: true, arrivedAt: true, durationSec: true, unitPriceEur: true, fuelType: true },
        orderBy: { arrivedAt: 'desc' },
        take: 500,
      });
      if (stops.length === 0) return { passages: 0 };
      const plates = await this.platesFor([...new Set(stops.map((s) => s.vehicleId))]);
      const perVehicle = new Map<string, number>();
      for (const s of stops) perVehicle.set(s.vehicleId, (perVehicle.get(s.vehicleId) ?? 0) + 1);
      const prices = stops.map((s) => s.unitPriceEur).filter((p): p is number => p != null);
      return {
        passages: stops.length,
        vehiculesDistincts: perVehicle.size,
        parVehicule: [...perVehicle.entries()]
          .map(([id, n]) => ({ vehicule: plates.get(id) ?? 'inconnu', passages: n }))
          .sort((a, b) => b.passages - a.passages)
          .slice(0, 10),
        dernierPassage: stops[0]!.arrivedAt.toISOString().slice(0, 10),
        arretMoyenMin: Math.round(stops.reduce((a, s) => a + s.durationSec, 0) / stops.length / 60),
        prixReleveEurL: prices.length
          ? { min: round3(Math.min(...prices)), max: round3(Math.max(...prices)), dernier: round3(prices[0]!) }
          : undefined,
        carburant: stops.find((s) => s.fuelType)?.fuelType ?? undefined,
      };
    }

    // Lieu non-station : on croise avec les zones mortes GPS (module « zones mortes »).
    const zones = await this.prisma.gpsDeadZone.findMany({
      where: { fleetId: place.fleetId },
      select: { vehicleId: true, centroidLat: true, centroidLng: true, occurrences: true, status: true },
      take: 500,
    });
    const near = zones.filter(
      (z) => distanceMeters(z.centroidLat, z.centroidLng, place.lat, place.lng) <= Math.max(place.radiusM, 150),
    );
    if (near.length === 0) return { vehiculesObserves: 0 };
    const plates = await this.platesFor([...new Set(near.map((z) => z.vehicleId))]);
    return {
      vehiculesObserves: near.length,
      pertesGpsTotales: near.reduce((a, z) => a + z.occurrences, 0),
      parVehicule: near
        .map((z) => ({ vehicule: plates.get(z.vehicleId) ?? 'inconnu', pertesGps: z.occurrences }))
        .sort((a, b) => b.pertesGps - a.pertesGps)
        .slice(0, 10),
      stationnementCouvertConfirme: near.some((z) => z.status === 'CONFIRMED_BENIGN'),
    };
  }

  private async platesFor(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.vehicle.findMany({ where: { id: { in: ids } }, select: { id: true, plate: true } });
    return new Map(rows.map((v) => [v.id, v.plate]));
  }
}

interface LlmOut {
  summary?: string;
  highlights?: string[];
  recommendations?: string[];
}

function clamp(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function clampList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().slice(0, MAX_ITEM))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function kindLabel(kind: FleetPlaceKind): string {
  switch (kind) {
    case FleetPlaceKind.FUEL_STATION: return 'station-service';
    case FleetPlaceKind.PARKING: return 'parking / stationnement';
    case FleetPlaceKind.DEPOT: return 'dépôt';
    default: return 'lieu';
  }
}

function toDto(row: {
  id: string; placeId: string; summary: string; highlights: unknown; recommendations: unknown;
  aiProvider: string | null; aiModel: string | null; costEur: number | null; origin: string;
  computedAt: Date; facts: unknown;
}): PlaceAnalysisDto {
  return {
    id: row.id,
    placeId: row.placeId,
    summary: row.summary,
    highlights: Array.isArray(row.highlights) ? (row.highlights as string[]) : [],
    recommendations: Array.isArray(row.recommendations) ? (row.recommendations as string[]) : [],
    aiProvider: row.aiProvider,
    aiModel: row.aiModel,
    costEur: row.costEur,
    origin: row.origin,
    computedAt: row.computedAt.toISOString(),
    /** Faits OSM figés, réaffichés tels quels (aucune reformulation). */
    facts: (row.facts as { openStreetMap?: PlaceFacts } | null)?.openStreetMap ?? null,
  };
}

export interface PlaceAnalysisDto {
  id: string;
  placeId: string;
  summary: string;
  highlights: string[];
  recommendations: string[];
  aiProvider: string | null;
  aiModel: string | null;
  costEur: number | null;
  origin: string;
  computedAt: string;
  facts: PlaceFacts | null;
}
