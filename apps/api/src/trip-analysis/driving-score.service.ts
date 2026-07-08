import { Injectable, Logger } from '@nestjs/common';
import type { DrivingScoreDetailDto, DrivingScoreRowDto, DrivingScoreScope, DrivingScoresDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

/** Borne dure d'analyses lues (perf). Au-delà, on tronque (le plus récent d'abord). */
const MAX_ANALYSES = 20_000;
/** Trajets à excès listés par ligne (les plus récents) — pour les liens vers le récit IA. */
const MAX_SPEEDING_REFS = 25;

type SpeedingRef = { tripId: string; vehicleId: string; startedAt: Date };

type Agg = {
  id: string; label: string; sublabel: string | null; color: string | null;
  sumScore: number; trips: number; distanceKm: number; speedingTrips: number; harshCount: number; fuelLiters: number; co2Kg: number;
  speedingRefs: SpeedingRef[];
};

/**
 * Notation (2026-07) — SCORE DE CONDUITE agrégé par véhicule / conducteur / groupe. Le score d'un
 * trajet = son éco-score déterministe (0-100, déjà calculé : excès, à-coups, ralenti). On MOYENNE sur
 * la période et on classe. Scoping anti-IDOR (périmètre véhicules de l'utilisateur). Aucun appel IA.
 */
@Injectable()
export class DrivingScoreService {
  private readonly logger = new Logger(DrivingScoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  async scores(user: AuthUser, scope: DrivingScoreScope, fromIso?: string, toIso?: string, fleetId?: string): Promise<DrivingScoresDto> {
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);

    // 1. Périmètre véhicules (anti-IDOR).
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const vehicleWhere = accessible === 'ALL'
      ? (fleetId ? { fleetId } : {})
      : { vehicleId: { in: accessible.length ? accessible : ['00000000-0000-0000-0000-000000000000'] } };

    // 2. Analyses (bornées) → métriques par trajet.
    const analyses = await this.prisma.tripAnalysis.findMany({
      where: vehicleWhere,
      select: { tripId: true, vehicleId: true, ecoScore: true, distanceKm: true, speedingCount: true, harshAccel: true, harshBrake: true, fuelLiters: true, co2Kg: true },
      orderBy: { computedAt: 'desc' },
      take: MAX_ANALYSES,
    });
    if (analyses.length >= MAX_ANALYSES) this.logger.warn(`scores : ${MAX_ANALYSES} analyses (tronqué).`);
    if (analyses.length === 0) return { scope, from: from.toISOString(), to: to.toISOString(), rows: [], overallScore: null, overallGrade: null, totalTrips: 0, rankedCount: 0 };

    // 3. Trajets correspondants DANS la période → conducteur + véhicule.
    const tripIds = analyses.map((a) => a.tripId);
    const trips = await this.prisma.trip.findMany({
      where: { id: { in: tripIds }, startedAt: { gte: from, lte: to } },
      select: { id: true, vehicleId: true, driverId: true, startedAt: true, driver: { select: { firstName: true, lastName: true, color: true } } },
    });
    const tripById = new Map(trips.map((t) => [t.id, t]));

    // 4. Libellés : plaques + modèles + groupes (une seule requête chacun).
    const vehIds = [...new Set(trips.map((t) => t.vehicleId))];
    const vehicles = vehIds.length
      ? await this.prisma.vehicle.findMany({ where: { id: { in: vehIds } }, select: { id: true, plate: true, brand: true, model: true, groups: { select: { group: { select: { id: true, name: true } } } } } })
      : [];
    const vehById = new Map(vehicles.map((v) => [v.id, v]));

    // 5. Agrégation par scope.
    const map = new Map<string, Agg>();
    let overallSum = 0;
    let overallTrips = 0;

    for (const a of analyses) {
      const t = tripById.get(a.tripId);
      if (!t) continue; // hors période
      const veh = vehById.get(t.vehicleId);
      const grp = veh?.groups?.[0]?.group ?? null;

      let key: string | null = null;
      let label = '';
      let sublabel: string | null = null;
      let color: string | null = null;
      if (scope === 'vehicle') {
        key = t.vehicleId; label = veh?.plate ?? '—'; sublabel = [veh?.brand, veh?.model].filter(Boolean).join(' ') || null;
      } else if (scope === 'driver') {
        if (!t.driverId || !t.driver) continue; // trajets sans conducteur exclus du classement conducteurs
        key = t.driverId; label = `${t.driver.firstName} ${t.driver.lastName}`.trim(); color = t.driver.color ?? null; sublabel = veh?.plate ? `dernier véhicule ${veh.plate}` : null;
      } else {
        if (!grp) continue; // véhicules sans groupe exclus du classement groupes
        key = grp.id; label = grp.name; sublabel = null;
      }
      if (!key) continue;

      let g = map.get(key);
      if (!g) { g = { id: key, label, sublabel, color, sumScore: 0, trips: 0, distanceKm: 0, speedingTrips: 0, harshCount: 0, fuelLiters: 0, co2Kg: 0, speedingRefs: [] }; map.set(key, g); }
      g.sumScore += a.ecoScore;
      g.trips += 1;
      g.distanceKm += a.distanceKm;
      if (a.speedingCount > 0) {
        g.speedingTrips += 1;
        g.speedingRefs.push({ tripId: a.tripId, vehicleId: t.vehicleId, startedAt: t.startedAt });
      }
      g.harshCount += a.harshAccel + a.harshBrake;
      g.fuelLiters += a.fuelLiters ?? 0;
      g.co2Kg += a.co2Kg ?? 0;
      overallSum += a.ecoScore;
      overallTrips += 1;
    }

    const rows: DrivingScoreRowDto[] = [...map.values()]
      .map((g) => {
        const score = Math.round(g.sumScore / g.trips);
        return {
          id: g.id, label: g.label, sublabel: g.sublabel, color: g.color,
          score, grade: grade(score), tripCount: g.trips,
          distanceKm: round(g.distanceKm, 1), speedingTrips: g.speedingTrips,
          speedingTripRefs: g.speedingRefs
            .sort((x, y) => y.startedAt.getTime() - x.startedAt.getTime())
            .slice(0, MAX_SPEEDING_REFS)
            .map((r) => ({ tripId: r.tripId, vehicleId: r.vehicleId, startedAt: r.startedAt.toISOString() })),
          harshCount: g.harshCount,
          fuelLiters: round(g.fuelLiters, 1), co2Kg: round(g.co2Kg, 1),
        };
      })
      .sort((a, b) => b.score - a.score || b.tripCount - a.tripCount);

    const overallScore = overallTrips > 0 ? Math.round(overallSum / overallTrips) : null;
    return {
      scope, from: from.toISOString(), to: to.toISOString(), rows,
      overallScore, overallGrade: overallScore != null ? grade(overallScore) : null, totalTrips: overallTrips,
      rankedCount: rows.length,
    };
  }

  /**
   * Score PERSO d'UNE entité (véhicule/conducteur/groupe) : sa note + son RANG dans le classement +
   * son écart à la moyenne. Réutilise `scores()` (même périmètre/anti-IDOR) puis extrait l'entité.
   */
  async entityScore(user: AuthUser, scope: DrivingScoreScope, id: string, fromIso?: string, toIso?: string, fleetId?: string): Promise<DrivingScoreDetailDto> {
    const all = await this.scores(user, scope, fromIso, toIso, fleetId);
    const idx = all.rows.findIndex((r) => r.id === id);
    const row = idx >= 0 ? all.rows[idx] : null;
    return {
      scope, id, from: all.from, to: all.to,
      row,
      rank: idx >= 0 ? idx + 1 : null,
      total: all.rows.length,
      overallScore: all.overallScore,
      overallGrade: all.overallGrade,
      vsOverall: row && all.overallScore != null ? row.score - all.overallScore : null,
    };
  }
}

/** Note lettrée à partir du score 0-100. */
function grade(score: number): string {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}
function round(v: number, d: number): number { const f = 10 ** d; return Math.round(v * f) / f; }
