import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type {
  AiCapacityApplyDto,
  AiCapacityProposalDto,
  AiCapacityResultDto,
  AiCapacitySuggestRequestDto,
  AiPlacementCandidateInput,
  AiPlacementProposalDto,
  AiPlacementResultDto,
  AiPlacementSuggestRequestDto,
  FleetMetier,
  FleetMetierDto,
  SetFleetMetierDto,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { ForecastService } from '../agenda/forecast.service';
import { ReservationsService } from '../agenda/reservations.service';
import { VehicleEventsService } from '../agenda/vehicle-events.service';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { AnthropicClient } from './anthropic.client';
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

/**
 * Sprint 9 — Copilote IA d'optimisation. L'IA PROPOSE (sortie structurée) ; l'app
 * VALIDE/APPLIQUE. Toutes les lectures passent par les services SCOPÉS (chaîne S5
 * anti-IDOR) : l'IA ne reçoit jamais que le périmètre de l'appelant. Aucune
 * proposition n'écrit en base : capacité → applyCapacity (perm vehicles_edit),
 * placement → flux de réservation S8 (request/confirm, gardes EXCLUDE + scoping).
 */
@Injectable()
export class AiOptimizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly events: VehicleEventsService,
    private readonly reservations: ReservationsService,
    private readonly forecast: ForecastService,
    private readonly anthropic: AnthropicClient,
  ) {}

  // ─── Capacité 1 — enrichissement de capacité (dry-run) ─────────────────────

  async suggestCapacity(user: AuthUser, dto: AiCapacitySuggestRequestDto): Promise<AiCapacityResultDto> {
    const fleetId = this.resolveFleetId(user, dto?.fleetId);
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { metier: true } });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    const metier = fleet.metier as FleetMetier;

    // Scoping anti-IDOR : un véhicule hors périmètre n'entre jamais dans le payload.
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
    if (vehicles.length === 0) return { metier, proposals: [] };

    // Énergie : depuis l'InstallationTask liée si disponible (le planning porte model + energy).
    const vids = vehicles.map((v) => v.id);
    const tasks = await this.prisma.installationTask.findMany({
      where: { vehicleId: { in: vids } },
      select: { vehicleId: true, energy: true },
      orderBy: { createdAt: 'asc' },
    });
    const energyByVeh = new Map<string, string | null>();
    for (const t of tasks) {
      // 1re tâche (la plus ancienne) gagne — déterministe grâce à l'orderBy.
      if (t.vehicleId && !energyByVeh.has(t.vehicleId)) energyByVeh.set(t.vehicleId, t.energy ?? null);
    }

    const payload = {
      metier,
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

    const ai = await this.anthropic.completeJson<CapacityAiOutput>({
      system: renderCapacitySystem(metier),
      userPayload: payload,
      schema: CAPACITY_SCHEMA,
      // Une proposition par véhicule : marge pour une grande flotte sans risquer le
      // timeout HTTP (16k = plafond non-stream confortable, ~200 véhicules).
      maxTokens: 16000,
    });

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

  // ─── Capacité 2 — optimiseur de placement (dry-run) ────────────────────────

  async suggestPlacement(user: AuthUser, dto: AiPlacementSuggestRequestDto): Promise<AiPlacementResultDto> {
    if (!dto?.startAt || !dto?.endAt) throw new BadRequestException('startAt et endAt (ISO) requis.');
    const start = new Date(dto.startAt);
    const end = new Date(dto.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
      throw new BadRequestException('Créneau invalide.');
    }
    const slot = { startAt: start.toISOString(), endAt: end.toISOString() };

    // Candidats = véhicules DISPONIBLES sur le créneau (scoping + conflits réels gérés par suggest()).
    const sug = await this.reservations.suggest(user, {
      startAt: dto.startAt,
      endAt: dto.endAt,
      criteria: dto.criteria,
    });
    if (sug.vehicles.length === 0) {
      return {
        slot,
        proposals: [],
        noGoodMatch: true,
        notes: 'Aucun véhicule libre ne correspond aux critères sur ce créneau.',
      };
    }

    // Prévision : indique « souvent pris à ce moment » (informe le tri, jamais bloquant).
    let forecastBusy = new Set<string>();
    try {
      const fc = await this.forecast.getForecast(user, start, end);
      forecastBusy = new Set(
        fc.slots
          .filter((s) => new Date(s.startAt).getTime() < end.getTime() && new Date(s.endAt).getTime() > start.getTime())
          .map((s) => s.vehicleId),
      );
    } catch {
      // best-effort : on continue sans la prévision si elle échoue.
    }

    const metier = await this.fleetMetier(user);
    const candidates: AiPlacementCandidateInput[] = sug.vehicles.map((v) => ({
      vehicleId: v.vehicleId,
      plate: v.vehiclePlate,
      seats: v.seats,
      childSeats: v.childSeats,
      features: v.features,
      utilizationRatio: v.utilizationRatio,
      underutilized: v.underutilized,
      forecastBusy: forecastBusy.has(v.vehicleId),
    }));
    const underutilizedCount = candidates.filter((c) => c.underutilized).length;
    const avg = candidates.reduce((s, c) => s + c.utilizationRatio, 0) / candidates.length;

    const payload = {
      metier,
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
      },
    };

    const ai = await this.anthropic.completeJson<PlacementAiOutput>({
      system: renderPlacementSystem(metier),
      userPayload: payload,
      schema: PLACEMENT_SCHEMA,
      maxTokens: 4096,
    });

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
          score: clamp01(p.score),
          reasoning: typeof p.reasoning === 'string' ? p.reasoning.slice(0, 400) : '',
        };
      })
      .sort((a, b) => b.score - a.score);

    return { slot, proposals, noGoodMatch: !!ai?.noGoodMatch, notes: ai?.notes ?? null };
  }

  private async fleetMetier(user: AuthUser): Promise<FleetMetier> {
    if (!user.fleetId) return 'GENERIC';
    const fleet = await this.prisma.fleet.findUnique({
      where: { id: user.fleetId },
      select: { metier: true },
    });
    return (fleet?.metier as FleetMetier) ?? 'GENERIC';
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
