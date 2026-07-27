import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type {
  AiCapacityApplyDto,
  AiCapacityInputDto,
  AiCapacityProposalDto,
  AiCapacityResultDto,
  AiCapacitySuggestRequestDto,
  AiPlacementCandidateInput,
  AiPlacementInputDto,
  AiPlacementProposalDto,
  AiPlacementResultDto,
  AiPlacementSuggestRequestDto,
  FleetMetier,
  FleetMetierDto,
  SetFleetMetierDto,
} from '@vizyo/tracky-shared';
import { DORMANT_STOP_COUNTING_MS, isVehicleDormant } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { ForecastService } from '../agenda/forecast.service';
import { ReservationsService } from '../agenda/reservations.service';
import { VehicleEventsService } from '../agenda/vehicle-events.service';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { AiServiceError, type AiErrorKind } from './anthropic.client';
import { AiRouter } from './ai-router.service';
import { AiAvailabilityService } from './ai-availability.service';
import {
  CAPACITY_SCHEMA,
  PLACEMENT_SCHEMA,
  renderCapacitySystem,
  renderPlacementSystem,
} from './ai.prompts';

/** Borne une valeur dans [0,1] ; non-fini → 0. */
function clamp01(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
/** Entier ≥ 0 ou null (refuse les valeurs aberrantes proposées par l'IA). */
function cleanInt(n: unknown): number | null {
  if (n === null || n === undefined) return null;
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return null;
  return Math.floor(x);
}
function cleanFeatures(f: unknown): string[] {
  if (!Array.isArray(f)) return [];
  return f.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean).slice(0, 20);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fenêtre « maintenance imminente » : maintenance prévue dans les 7 jours suivant le créneau. */
const MAINT_SOON_MS = 7 * DAY_MS;
/**
 * Coût/km INDICATIF pour aider l'IA à mutualiser vers le véhicule le moins cher à mission égale.
 * Prix carburant TTC moyens France (approximatifs, 2026) ; l'électrique est estimé à un forfait
 * recharge dépôt. Volontairement grossier : sert au CLASSEMENT relatif, pas à une facturation.
 */
const FUEL_PRICE_EUR_PER_L: Record<string, number> = { DIESEL: 1.75, ESSENCE: 1.9, HYBRIDE: 1.9 };
const DEFAULT_CONSO_L100: Record<string, number> = { DIESEL: 6.5, ESSENCE: 7.5, HYBRIDE: 5 };
const ELECTRIC_COST_PER_KM = 0.03;

/** Estime un coût/km (€) depuis l'énergie + la conso (L/100km si connue, sinon défaut par énergie). */
function estimateCostPerKm(energy: string | null, consoL100: number | null): number | null {
  if (!energy) return null;
  if (energy === 'ELECTRIQUE') return ELECTRIC_COST_PER_KM;
  const price = FUEL_PRICE_EUR_PER_L[energy];
  if (!price) return null;
  const conso = consoL100 && consoL100 > 0 ? consoL100 : DEFAULT_CONSO_L100[energy];
  if (!conso) return null;
  return Math.round((conso / 100) * price * 1000) / 1000; // €/km, 3 décimales
}

/**
 * Métadonnées véhicule du placement. `tracker` est joint à la requête coût DÉJÀ faite (et non
 * chargé par une requête dédiée) : le VPS tourne sur 2 vCPU, une lecture de plus par suggestion
 * IA se paierait à chaque clic.
 */
type PlacementVehicleMeta = {
  id: string;
  energy: string | null;
  fuelConsumptionL100km: number | null;
  tracker: { id: string; lastSeenAt: Date | null } | null;
};

/**
 * Le seuil de dormance en JOURS, dérivé de la constante partagée et non réécrit « 7 » à la main.
 *
 * Ces jours partent dans deux textes lus par des humains (la note `noGoodMatch`) et par le modèle
 * (`scopeNote`). Un littéral y survivrait à un changement de seuil et affirmerait alors une durée
 * fausse à l'exploitant — le genre d'écart qu'aucun test ne rattrape parce que la phrase reste
 * grammaticalement correcte.
 */
const DORMANT_COUNTING_DAYS = Math.round(DORMANT_STOP_COUNTING_MS / (24 * 60 * 60 * 1000));

type CapacityVehicleRow = {
  id: string;
  plate: string | null;
  type: string;
  brand: string | null;
  model: string | null;
  seats: number | null;
  childSeats: number | null;
  features: string[];
};

type CapacityAiOutput = {
  proposals: Array<{
    vehicleId: string;
    seats: number | null;
    childSeats: number | null;
    features: string[];
    confidence: number;
    reasoning: string;
  }>;
};
type PlacementAiOutput = {
  proposals: Array<{ vehicleId: string; score: number; reasoning: string }>;
  noGoodMatch: boolean;
  notes?: string | null;
};

/** Anti-spam des alertes IA : 1 entrée / fenêtre par (capacité, flotte, nature). */
const AI_ALERT_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Sprint 9 — Copilote IA d'optimisation. L'IA PROPOSE (sortie structurée) ; l'app
 * VALIDE/APPLIQUE. Toutes les lectures passent par les services SCOPÉS (chaîne S5
 * anti-IDOR) : l'IA ne reçoit jamais que le périmètre de l'appelant. Aucune
 * proposition n'écrit en base : capacité → applyCapacity (perm vehicles_edit),
 * placement → flux de réservation S8 (request/confirm, gardes EXCLUDE + scoping).
 *
 * Les `preview*` renvoient le PAYLOAD EXACT envoyé à Claude (sans appel) → permet de
 * tester en Console avec les vraies données live + prouve la fraîcheur du parc.
 * Chaque échec IA est journalisé (ErrorLogger, source AI_OPTIMIZER) → centre d'alerte.
 */
@Injectable()
export class AiOptimizationService {
  /** Dernière alerte IA émise par clé (anti-spam). */
  private readonly aiErrLast = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly events: VehicleEventsService,
    private readonly reservations: ReservationsService,
    private readonly forecast: ForecastService,
    private readonly ai: AiRouter,
    private readonly aiAvail: AiAvailabilityService,
    private readonly errors: ErrorLogger,
    private readonly aiUsage: AiUsageService,
  ) {}

  // ─── Capacité 1 — enrichissement de capacité ───────────────────────────────

  /** Construit le payload capacité (scopé). Réutilisé par preview + suggest. */
  private async buildCapacityPayload(
    user: AuthUser,
    dto: AiCapacitySuggestRequestDto,
  ): Promise<{ payload: AiCapacityInputDto; vehicles: CapacityVehicleRow[]; metier: FleetMetier; fleetId: string }> {
    const fleetId = this.resolveFleetId(user, dto?.fleetId);
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { metier: true, name: true } });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    const metier = fleet.metier as FleetMetier;

    // Scoping anti-IDOR : un véhicule hors périmètre n'entre jamais dans le payload.
    //
    // Les DORMANTS restent VOLONTAIREMENT dans ce payload-ci, contrairement au placement : on
    // demande ici combien de places a une Citroën ë-Jumpy, pas si elle est disponible mardi.
    // Le nombre de places est une caractéristique PHYSIQUE et permanente ; elle ne dépend pas de
    // l'état du boîtier. Les écarter creuserait un trou définitif dans la fiche des véhicules
    // muets — trou que plus rien ne viendrait combler, y compris après leur retour.
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const ids = resolveReportVehicleScope(accessible, dto?.vehicleIds); // 403 si sous-ensemble hors périmètre
    const where: Prisma.VehicleWhereInput = { fleetId };
    if (ids !== 'ALL') where.id = { in: ids };
    const vehicles = await this.prisma.vehicle.findMany({
      where,
      select: {
        id: true, plate: true, type: true, brand: true, model: true,
        seats: true, childSeats: true, features: true,
      },
      take: 2000,
    });

    // Énergie : depuis l'InstallationTask liée si disponible (le planning porte model + energy).
    const vids = vehicles.map((v) => v.id);
    const tasks = vids.length
      ? await this.prisma.installationTask.findMany({
          where: { vehicleId: { in: vids } },
          select: { vehicleId: true, energy: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const energyByVeh = new Map<string, string | null>();
    for (const t of tasks) {
      // 1re tâche (la plus ancienne) gagne — déterministe grâce à l'orderBy.
      if (t.vehicleId && !energyByVeh.has(t.vehicleId)) energyByVeh.set(t.vehicleId, t.energy ?? null);
    }

    const payload: AiCapacityInputDto = {
      metier,
      fleetContext: fleet.name ?? null,
      vehicles: vehicles.map((v) => ({
        vehicleId: v.id,
        plate: v.plate,
        type: v.type,
        brand: v.brand,
        model: v.model,
        energy: energyByVeh.get(v.id) ?? null,
        currentSeats: v.seats,
        currentChildSeats: v.childSeats,
        currentFeatures: v.features,
      })),
    };
    return { payload, vehicles, metier, fleetId };
  }

  /** Aperçu du payload capacité (DRY-RUN, aucun appel Claude) — testable en Console. */
  async previewCapacity(user: AuthUser, dto: AiCapacitySuggestRequestDto): Promise<AiCapacityInputDto> {
    return (await this.buildCapacityPayload(user, dto)).payload;
  }

  async suggestCapacity(user: AuthUser, dto: AiCapacitySuggestRequestDto): Promise<AiCapacityResultDto> {
    const { payload, vehicles, metier, fleetId } = await this.buildCapacityPayload(user, dto);
    if (vehicles.length === 0) return { metier, proposals: [] };
    // Interrupteur maître : IA désactivée pour la flotte → aucune proposition (l'app tourne sans IA).
    if (!(await this.aiAvail.isEnabledForFleet(fleetId, 'capacity'))) return { metier, proposals: [] };

    let ai: CapacityAiOutput;
    try {
      const call = await this.ai.completeJson<CapacityAiOutput>({
        system: renderCapacitySystem(metier),
        userPayload: payload,
        schema: CAPACITY_SCHEMA,
        // Une proposition par véhicule : marge pour une grande flotte sans risquer le
        // timeout HTTP (16k = plafond non-stream confortable, ~200 véhicules).
        maxTokens: 16000,
      });
      ai = call.result;
      // Palier « Coûts IA » — journalise l'usage (non bloquant).
      void this.aiUsage.record({
        userId: user.id, fleetId, action: 'capacity', model: call.model,
        inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
        cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
        latencyMs: call.latencyMs, ok: true,
      });
    } catch (err) {
      await this.recordAiFailure(err, 'capacity', { userId: user.id, fleetId, vehicleCount: vehicles.length });
      throw err;
    }

    const byId = new Map(vehicles.map((v) => [v.id, v]));
    const proposals: AiCapacityProposalDto[] = (ai?.proposals ?? [])
      .filter((p) => p && byId.has(p.vehicleId)) // anti-hallucination : on ignore tout id inconnu
      .map((p) => {
        const v = byId.get(p.vehicleId)!;
        return {
          vehicleId: p.vehicleId,
          plate: v.plate,
          model: v.model,
          seats: cleanInt(p.seats),
          childSeats: cleanInt(p.childSeats),
          features: cleanFeatures(p.features),
          confidence: clamp01(p.confidence),
          reasoning: typeof p.reasoning === 'string' ? p.reasoning.slice(0, 400) : '',
        };
      });
    return { metier, proposals };
  }

  /** Application HUMAINE des propositions acceptées → écrit les véhicules (scopé). */
  async applyCapacity(user: AuthUser, dto: AiCapacityApplyDto): Promise<{ updated: number }> {
    const items = Array.isArray(dto?.items) ? dto.items : [];
    if (items.length === 0) throw new BadRequestException('Aucune capacité à appliquer.');
    if (items.length > 500) throw new BadRequestException('Trop de véhicules en une fois (max 500).');
    let updated = 0;
    for (const it of items) {
      if (!it?.vehicleId) continue;
      await this.events.assertVehicleAccess(user, it.vehicleId); // 403/404 si hors périmètre
      const data: Prisma.VehicleUpdateInput = {};
      if (it.seats !== undefined) data.seats = cleanInt(it.seats);
      if (it.childSeats !== undefined) data.childSeats = cleanInt(it.childSeats);
      if (it.features !== undefined) data.features = cleanFeatures(it.features);
      if (Object.keys(data).length === 0) continue;
      await this.prisma.vehicle.update({ where: { id: it.vehicleId }, data });
      updated++;
    }
    return { updated };
  }

  // ─── Capacité 2 — optimiseur de placement ──────────────────────────────────

  /** Construit le payload placement (scopé, candidats disponibles). Réutilisé par preview + suggest. */
  private async buildPlacementPayload(
    user: AuthUser,
    dto: AiPlacementSuggestRequestDto,
  ): Promise<{
    payload: AiPlacementInputDto;
    candidates: AiPlacementCandidateInput[];
    slot: { startAt: string; endAt: string };
    excluded: { unknownCapacity: number; immobilized: number; dormant: number };
    fleetId: string;
  }> {
    if (!dto?.startAt || !dto?.endAt) throw new BadRequestException('startAt et endAt (ISO) requis.');
    const start = new Date(dto.startAt);
    const end = new Date(dto.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
      throw new BadRequestException('Créneau invalide.');
    }
    const slot = { startAt: start.toISOString(), endAt: end.toISOString() };

    // Calibrage flotte : le placement raisonne sur UNE société (comme la capacité). Un super-admin
    // DOIT préciser la flotte (sinon 400) — sans quoi les candidats agrègent TOUTES les sociétés et
    // le métier retombe sur GENERIC. Le métier + le nom viennent de CETTE flotte (injectés au prompt).
    const fleetId = this.resolveFleetId(user, dto?.fleetId);
    const fleet = await this.prisma.fleet.findUnique({
      where: { id: fleetId },
      select: { metier: true, name: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    const metier = fleet.metier as FleetMetier;

    // Candidats = véhicules DISPONIBLES sur le créneau, SCOPÉS à la flotte résolue
    // (scoping + conflits réels gérés par suggest()).
    const sug = await this.reservations.suggest(user, {
      startAt: dto.startAt,
      endAt: dto.endAt,
      criteria: dto.criteria,
      fleetId,
    });

    // Prévision : indique « souvent pris à ce moment » (informe le tri, jamais bloquant).
    let forecastBusy = new Set<string>();
    try {
      const fc = await this.forecast.getForecast(user, start, end, fleetId);
      forecastBusy = new Set(
        fc.slots
          .filter((s) => new Date(s.startAt).getTime() < end.getTime() && new Date(s.endAt).getTime() > start.getTime())
          .map((s) => s.vehicleId),
      );
    } catch {
      // best-effort : on continue sans la prévision si elle échoue.
    }

    // Enrichissement COÛT (P3) : énergie + coût/km estimé + maintenance imminente par candidat,
    // pour que l'IA puisse mutualiser vers le véhicule le moins cher À MISSION ÉGALE.
    // `tracker.lastSeenAt` voyage dans CETTE requête (et pas une de plus) : il sert à écarter
    // les DORMANTS juste en dessous.
    const candidateIds = sug.vehicles.map((v) => v.vehicleId);
    const [meta, maintRows] = await Promise.all([
      candidateIds.length
        ? this.prisma.vehicle.findMany({
            where: { id: { in: candidateIds } },
            select: {
              id: true,
              energy: true,
              fuelConsumptionL100km: true,
              tracker: { select: { id: true, lastSeenAt: true } },
            },
          })
        : Promise.resolve([] as PlacementVehicleMeta[]),
      candidateIds.length
        ? this.prisma.vehicleEvent.findMany({
            where: {
              vehicleId: { in: candidateIds },
              type: VehicleEventType.MAINTENANCE,
              status: { in: [VehicleEventStatus.PLANNED, VehicleEventStatus.OPEN, VehicleEventStatus.IN_PROGRESS] },
              startAt: { gte: new Date(start.getTime() - DAY_MS), lte: new Date(start.getTime() + MAINT_SOON_MS) },
            },
            select: { vehicleId: true },
          })
        : Promise.resolve([] as { vehicleId: string }[]),
    ]);
    const metaById = new Map(meta.map((m) => [m.id, m]));
    const maintSet = new Set(maintRows.map((r) => r.vehicleId));

    // ── DORMANCE — on ne propose pas un véhicule qu'on ne sait plus joindre ────────────────
    //
    // Cas réel : FV-941-LZ, boîtier muet depuis 89 jours. Il n'a aucun trajet, donc son
    // `utilizationRatio` vaut 0 : c'est LE candidat que l'IA classe en tête au titre de la
    // mutualisation (critère 3 du prompt). La proposition arrive en tête de liste, un exploitant
    // la valide, et découvre à la remise des clés que le véhicule n'est plus là. On paie des
    // jetons pour produire un conseil inapplicable.
    //
    // Le vivier lui-même (`reservations.suggest`) écarte déjà les muets : ce filtre-ci est une
    // SECONDE barrière, tenue par le service qui construit le payload facturé. Elle vaut son
    // coût (une colonne de plus sur une requête déjà faite) parce que ce chemin-ci est le seul
    // qui envoie des véhicules à un moteur payant : si un jour le vivier change de règle ou
    // qu'un autre appelant l'alimente, l'IA ne recommencera pas à proposer un fantôme.
    //
    // Semantique volontaire : un véhicule SANS boîtier, ou dont le boîtier n'a JAMAIS émis, n'est
    // PAS dormant — il n'est pas suivi, mais il est bel et bien réservable (cf. isVehicleDormant).
    const now = Date.now();
    const dormantIds = new Set(
      sug.vehicles
        .filter((v) => {
          const t = metaById.get(v.vehicleId)?.tracker;
          return isVehicleDormant(
            { trackerId: t?.id ?? null, lastSeenAt: t?.lastSeenAt ?? null },
            now,
            // 7 j, EXPLICITEMENT — même seuil que le vivier amont, écrit ici plutôt que laissé au
            // défaut. Ce chemin PROPOSE, il n'agit pas : basculer sur le seuil « arrêter d'AGIR »
            // (72 h) retirerait des propositions un véhicule simplement garé le temps d'un pont,
            // et le client verrait son parc proposable rétrécir sans que rien n'ait changé.
            DORMANT_STOP_COUNTING_MS,
          );
        })
        .map((v) => v.vehicleId),
    );
    // Total = ce que le vivier a déjà écarté + ce qu'on écarte ici. Aucun double comptage
    // possible : un véhicule écarté en amont ne figure plus dans `sug.vehicles`, donc il ne peut
    // pas être recompté ci-dessus. Le garde `Number.isFinite` couvre les appelants qui ne
    // renseignent pas encore le compteur (le champ est jeune) — un `undefined` ferait un NaN
    // qui s'afficherait tel quel dans l'UI.
    const upstreamDormant = sug.excludedDormant;
    const excludedDormant =
      (Number.isFinite(upstreamDormant) && upstreamDormant > 0 ? upstreamDormant : 0) + dormantIds.size;

    const candidates: AiPlacementCandidateInput[] = sug.vehicles
      .filter((v) => !dormantIds.has(v.vehicleId))
      .map((v) => {
        const m = metaById.get(v.vehicleId);
        const energy = m?.energy ?? null;
        return {
          vehicleId: v.vehicleId,
          plate: v.vehiclePlate,
          seats: v.seats,
          childSeats: v.childSeats,
          features: v.features,
          utilizationRatio: v.utilizationRatio,
          underutilized: v.underutilized,
          forecastBusy: forecastBusy.has(v.vehicleId),
          energy,
          costPerKm: estimateCostPerKm(energy, m?.fuelConsumptionL100km ?? null),
          upcomingMaintenance: maintSet.has(v.vehicleId),
        };
      });
    const underutilizedCount = candidates.filter((c) => c.underutilized).length;
    const avg = candidates.length ? candidates.reduce((s, c) => s + c.utilizationRatio, 0) / candidates.length : 0;
    const costs = candidates.map((c) => c.costPerKm).filter((x): x is number => typeof x === 'number');
    const cheapestCostPerKm = costs.length ? Math.min(...costs) : null;

    const payload: AiPlacementInputDto = {
      metier,
      fleetContext: fleet.name ?? null,
      // Le résumé est calculé sur les candidats RESTANTS : sans cette phrase, le modèle lit
      // « totalVehicles: 3 » comme « cette société a 3 véhicules » et bâtit son conseil de
      // mutualisation sur un parc qui n'est pas celui qu'on lui a montré.
      // ⚠️ « du périmètre analysé », PAS « de cette flotte » : `suggest()` est déjà borné aux
      // véhicules accessibles à CET utilisateur (un chef de groupe ne voit que son groupe) puis
      // aux véhicules conformes aux critères. Écrire « de cette flotte » ferait affirmer au modèle,
      // dans ses « notes » rendues à l'exploitant, un état du parc ENTIER que le serveur n'a jamais
      // mesuré — et un chef de groupe lirait « 2 véhicules hors service » sur une flotte de 40.
      ...(excludedDormant > 0
        ? {
            scopeNote:
              `${excludedDormant} véhicule(s) du périmètre analysé sont exclus de cette analyse : leur ` +
              `boîtier n'émet plus depuis plus de ${DORMANT_COUNTING_DAYS} jours, ils sont donc injoignables ` +
              `et non affectables. « candidates » et « fleetSummary » ne décrivent QUE le parc réellement ` +
              `suivi. Ne propose jamais un véhicule absent de « candidates », ne raisonne pas sur un parc ` +
              `plus large, et n'affirme rien sur les véhicules exclus au-delà de leur nombre.`,
          }
        : {}),
      request: {
        startAt: slot.startAt,
        endAt: slot.endAt,
        title: dto.title,
        reason: dto.reason,
        criteria: dto.criteria,
      },
      candidates,
      fleetSummary: {
        totalVehicles: candidates.length,
        underutilizedCount,
        avgUtilization: Math.round(avg * 100) / 100,
        cheapestCostPerKm,
        dormantExcluded: excludedDormant,
      },
    };
    return {
      payload,
      candidates,
      slot,
      // Transparence UI : véhicules écartés AVANT le raisonnement IA (résultats non faussés en silence).
      excluded: {
        unknownCapacity: sug.excludedUnknownCapacity ?? 0,
        immobilized: sug.excludedImmobilized ?? 0,
        dormant: excludedDormant,
      },
      fleetId,
    };
  }

  /** Aperçu du payload placement (DRY-RUN, aucun appel Claude) — testable en Console. */
  async previewPlacement(user: AuthUser, dto: AiPlacementSuggestRequestDto): Promise<AiPlacementInputDto> {
    return (await this.buildPlacementPayload(user, dto)).payload;
  }

  async suggestPlacement(user: AuthUser, dto: AiPlacementSuggestRequestDto): Promise<AiPlacementResultDto> {
    const { payload, candidates, slot, excluded, fleetId } = await this.buildPlacementPayload(user, dto);
    if (candidates.length === 0) {
      return {
        slot,
        proposals: [],
        noGoodMatch: true,
        // « Aucun véhicule » tout court laisserait croire que la flotte est pleine sur ce créneau
        // alors que la vraie cause est un parc qui ne répond plus : on nomme la cause, sinon
        // l'exploitant cherche un conflit d'agenda qui n'existe pas.
        notes:
          excluded.dormant > 0
            ? `Aucun véhicule libre ne correspond aux critères sur ce créneau (${excluded.dormant} véhicule(s) écarté(s) : boîtier muet depuis plus de ${DORMANT_COUNTING_DAYS} jours).`
            : 'Aucun véhicule libre ne correspond aux critères sur ce créneau.',
        excludedUnknownCapacity: excluded.unknownCapacity,
        excludedImmobilized: excluded.immobilized,
        excludedDormant: excluded.dormant,
      };
    }
    // Interrupteur maître : IA désactivée pour la flotte → pas de placement IA (l'app tourne sans IA).
    if (!(await this.aiAvail.isEnabledForFleet(fleetId, 'placement'))) {
      return {
        slot,
        proposals: [],
        noGoodMatch: true,
        notes: 'Assistance IA désactivée pour cette flotte.',
        excludedUnknownCapacity: excluded.unknownCapacity,
        excludedImmobilized: excluded.immobilized,
        excludedDormant: excluded.dormant,
      };
    }

    let ai: PlacementAiOutput;
    let aiCostEur: number | null = null;
    try {
      const call = await this.ai.completeJson<PlacementAiOutput>({
        system: renderPlacementSystem(payload.metier),
        userPayload: payload,
        schema: PLACEMENT_SCHEMA,
        // 8192 : une longue liste de propositions (grosse flotte) pouvait être tronquée à 4096.
        maxTokens: 8192,
      });
      ai = call.result;
      // Transparence : coût € de CET appel (même calcul que le palier « Coûts IA »).
      aiCostEur = Math.round(this.aiUsage.costOf(call.model, call.usage) * this.aiUsage.eurRate() * 10000) / 10000;
      void this.aiUsage.record({
        userId: user.id, fleetId, action: 'placement', model: call.model,
        inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens,
        cacheWriteTokens: call.usage.cacheWriteTokens, cacheReadTokens: call.usage.cacheReadTokens,
        latencyMs: call.latencyMs, ok: true,
      });
    } catch (err) {
      await this.recordAiFailure(err, 'placement', { userId: user.id, fleetId });
      throw err;
    }

    const byId = new Map(candidates.map((c) => [c.vehicleId, c]));
    const proposals: AiPlacementProposalDto[] = (ai?.proposals ?? [])
      .filter((p) => p && byId.has(p.vehicleId)) // anti-hallucination
      .map((p) => {
        const c = byId.get(p.vehicleId)!;
        return {
          vehicleId: p.vehicleId,
          plate: c.plate,
          seats: c.seats,
          childSeats: c.childSeats,
          energy: c.energy ?? null,
          costPerKm: c.costPerKm ?? null,
          score: clamp01(p.score),
          reasoning: typeof p.reasoning === 'string' ? p.reasoning.slice(0, 400) : '',
        };
      })
      .sort((a, b) => b.score - a.score);

    return {
      slot,
      proposals,
      noGoodMatch: !!ai?.noGoodMatch,
      notes: ai?.notes ?? null,
      excludedUnknownCapacity: excluded.unknownCapacity,
      excludedImmobilized: excluded.immobilized,
      excludedDormant: excluded.dormant,
      aiCostEur,
    };
  }

  // ─── Journalisation des échecs IA → centre d'alerte ────────────────────────

  /** Journalise un échec IA (source AI_OPTIMIZER) avec anti-spam. Ne propage pas d'erreur. */
  private async recordAiFailure(
    err: unknown,
    capability: 'capacity' | 'placement',
    ctx: { userId?: string; fleetId?: string; vehicleCount?: number },
  ): Promise<void> {
    const kind: AiErrorKind = err instanceof AiServiceError ? err.kind : 'http';
    // Clé IA configurée mais invalide = vrai incident (CRITICAL) ; le reste = ERROR.
    const level: 'ERROR' | 'CRITICAL' = kind === 'invalid_key' ? 'CRITICAL' : 'ERROR';
    const key = `${capability}:${ctx.fleetId ?? 'all'}:${kind}`;
    const now = Date.now();
    const last = this.aiErrLast.get(key);
    if (last && now - last < AI_ALERT_THROTTLE_MS) return; // anti-spam
    this.aiErrLast.set(key, now);
    const message = err instanceof Error ? err.message : String(err);
    try {
      await this.errors.record(message, 'AI_OPTIMIZER', { ...ctx, capability, kind }, level);
    } catch {
      // la journalisation ne doit jamais casser la requête.
    }
  }

  // ─── Métier de la flotte (lecture / réglage) ───────────────────────────────

  async getFleetMetier(user: AuthUser, fleetId?: string): Promise<FleetMetierDto> {
    const id = this.resolveFleetId(user, fleetId);
    const fleet = await this.prisma.fleet.findUnique({
      where: { id },
      select: { id: true, name: true, metier: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    return { fleetId: fleet.id, fleetName: fleet.name, metier: fleet.metier as FleetMetier };
  }

  async setFleetMetier(user: AuthUser, dto: SetFleetMetierDto): Promise<FleetMetierDto> {
    const allowed: FleetMetier[] = ['CHILDREN_TRANSPORT', 'PARCELS', 'RENTAL', 'GENERIC'];
    if (!dto?.metier || !allowed.includes(dto.metier)) {
      throw new BadRequestException('Métier invalide.');
    }
    const id = this.resolveFleetId(user, dto.fleetId);
    const existing = await this.prisma.fleet.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('Flotte introuvable.');
    const updated = await this.prisma.fleet.update({
      where: { id },
      data: { metier: dto.metier },
      select: { id: true, name: true, metier: true },
    });
    return { fleetId: updated.id, fleetName: updated.name, metier: updated.metier as FleetMetier };
  }

  /** Résout la flotte cible (propre flotte ou, super-admin, celle passée) + garde de périmètre. */
  private resolveFleetId(user: AuthUser, fleetId?: string): string {
    const id = fleetId ?? user.fleetId ?? undefined;
    if (!id) throw new BadRequestException('Préciser la flotte (fleetId).');
    if (user.role !== UserRole.SUPER_ADMIN && id !== user.fleetId) {
      throw new ForbiddenException('Flotte hors périmètre.');
    }
    return id;
  }
}
