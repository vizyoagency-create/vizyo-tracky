import { createHash } from 'node:crypto';
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

    // ── Budget mensuel global : il doit protéger AUSSI le déclenchement humain, sinon le plafond
    // ne vaut que pour le cron et n'importe quel clic peut le dépasser.
    if (await this.monthBudgetExhausted()) {
      throw new ServiceUnavailableException(
        "Le budget IA mensuel est atteint. L'analyse sera de nouveau possible le mois prochain, ou après relèvement du budget.",
      );
    }

    const { facts, hash } = await this.gatherFacts(place);
    // Déclenchement HUMAIN : on ne saute jamais sur « faits inchangés ». Quelqu'un qui clique
    // « Relancer » demande explicitement une nouvelle passe — c'est l'automatisation, et elle
    // seule, qui a le devoir de ne pas repayer pour rien.
    const { analysis } = await this.analyzeFromFacts(place, facts, hash, origin, origin === 'manual' ? user.id : null);
    return analysis;
  }

  /**
   * Le budget IA mensuel est-il consommé ?
   *
   * ⚠️ DELEGUE a `AiUsageService`, qui porte desormais la regle pour TOUS les appelants
   * (elle est appliquee dans `AiRouterService.completeJson`). Cette methode reste comme
   * pre-controle : elle evite d'aller interroger OpenStreetMap et de construire les faits
   * pour un appel qui sera refuse — et elle permet a l'automatisation de le dire.
   *
   * On ne garde PAS de copie de la regle : deux definitions du meme plafond finiraient
   * par diverger, et c'est exactement comme ca qu'un plafond cesse de plafonner.
   */
  async monthBudgetExhausted(): Promise<boolean> {
    return this.aiUsage.monthBudgetExhausted();
  }

  /**
   * Faits + EMPREINTE stable, **sans aucun appel IA** (donc gratuit : OSM et la base seulement).
   * C'est ce qui permet à l'automatisation de décider *avant* de dépenser si une nouvelle analyse
   * apporterait quoi que ce soit.
   */
  async gatherFacts(place: PlaceForAnalysis): Promise<{ facts: Record<string, unknown>; hash: string }> {
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
    return { facts, hash: fingerprint(facts) };
  }

  /**
   * Appel IA + persistance à partir de faits DÉJÀ collectés. Renvoie le coût RÉEL de l'appel pour
   * que l'appelant puisse tenir un plafond de dépense. Ne vérifie PAS la porte IA : l'appelant l'a
   * déjà fait (l'automatisation la vérifie par société, avant même de collecter les faits).
   */
  async analyzeFromFacts(
    place: PlaceForAnalysis,
    facts: Record<string, unknown>,
    hash: string,
    origin: 'manual' | 'scheduled',
    userId: string | null,
  ): Promise<{ analysis: PlaceAnalysisDto; costEur: number }> {
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

    // ══ À PARTIR D'ICI, L'APPEL EST PAYÉ. ══════════════════════════════════════════════════════
    // Tout échec en aval (journalisation, calcul, écriture en base) doit malgré tout REMONTER LE
    // COÛT à l'appelant : sinon l'automatisation compterait 0 € pour une dépense réelle, ses
    // plafonds testeraient des compteurs figés, et une panne de base la ferait payer TOUS les
    // lieux en affichant « 0 € ». D'où le `paidCostEur` attaché à l'erreur (cf. `PaidCallError`).
    const costEur = Math.round(this.aiUsage.costOf(res.model, res.usage) * this.aiUsage.eurRate() * 10000) / 10000;
    try {
      return await this.persist(place, facts, hash, origin, userId, res, costEur);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      (wrapped as PaidCallError).paidCostEur = costEur;
      this.errorLogger.recordBackground(wrapped, 'place-analysis', {
        placeId: place.id, fleetId: place.fleetId, costEur,
        note: 'analyse PAYEE mais non enregistree (le cout est bien compte)',
      });
      throw wrapped;
    }
  }

  /** Journalisation du coût + persistance. Isolé pour que son échec n'efface pas la dépense. */
  private async persist(
    place: PlaceForAnalysis,
    facts: Record<string, unknown>,
    hash: string,
    origin: 'manual' | 'scheduled',
    userId: string | null,
    res: { model: string; provider: string; usage: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }; latencyMs: number; result?: LlmOut },
    costEur: number,
  ): Promise<{ analysis: PlaceAnalysisDto; costEur: number }> {
    // ── Coût : OBLIGATOIRE après chaque appel, sinon il n'apparaît pas dans « Coûts IA ».
    // `userId` null pour un run planifié → la ligne apparaît en « — (système) » dans le tableau.
    void this.aiUsage.record({
      userId,
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
        factsHash: hash,
        computedByUserId: userId,
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
        factsHash: hash,
        computedByUserId: userId,
        computedAt: new Date(),
      },
    });
    return { analysis: toDto(row), costEur };
  }

  /**
   * Usage RÉEL du lieu par la flotte — c'est ce qui rend l'analyse utile (l'IA seule ne saurait rien
   * de tes véhicules). Station : passages + véhicules + prix relevés. Parking/dépôt : zones mortes
   * GPS rattachées, c'est-à-dire les véhicules qui y perdent le signal (stationnement couvert).
   */
  private async usageFacts(place: PlaceForAnalysis): Promise<Record<string, unknown>> {
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

/** Champs d'un lieu nécessaires à l'analyse (sous-ensemble de `FleetPlace`). */
export interface PlaceForAnalysis {
  id: string;
  fleetId: string;
  name: string;
  kind: FleetPlaceKind;
  lat: number;
  lng: number;
  radiusM: number;
  note: string | null;
  stationId: string | null;
}

interface LlmOut {
  summary?: string;
  highlights?: string[];
  recommendations?: string[];
}

/**
 * Erreur survenue APRÈS un appel IA déjà facturé. `paidCostEur` permet à l'appelant de compter la
 * dépense malgré l'échec — sans quoi ses plafonds de coût seraient aveugles aux pannes.
 */
export interface PaidCallError extends Error {
  paidCostEur?: number;
}

/**
 * Empreinte des faits — base du garde-fou « ne pas repayer pour un résultat identique ».
 * Sérialisation à CLÉS TRIÉES : sans ça, deux objets identiques mais construits dans un ordre
 * différent donneraient deux empreintes différentes, et le garde-fou ne servirait jamais.
 */
function fingerprint(facts: unknown): string {
  return createHash('sha256').update(stableStringify(facts)).digest('hex').slice(0, 32);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
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
