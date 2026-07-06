import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';

/**
 * V1.5 (Sprint L) — Agregation KPI pour les rapports & export.
 *
 * Fournit `compute(fleetId, from, to)` qui retourne les statistiques
 * consolidees d'une flotte sur une periode donnee : km, duree, vitesse moyenne,
 * top vehicules, alertes, consommation estimee.
 *
 * La consommation est estimee via :
 *   distance_km * (Vehicle.fuelConsumptionL100km || default_par_type) / 100
 *   * Fleet.fuelPriceEurL
 */

const DEFAULT_CONSUMPTION_L100KM: Record<string, number> = {
  CAR: 7,
  TRUCK: 22,
  VAN: 10,
  MOTORCYCLE: 4,
  BICYCLE: 0,
  BUS: 28,
  CONSTRUCTION: 18,
  OTHER: 8,
};

export interface FleetStatsReport {
  fleet: { id: string; name: string };
  period: { from: string; to: string; days: number };
  vehicles: {
    total: number;
    activeDuringPeriod: number;
  };
  trips: {
    count: number;
    totalKm: number;
    totalDurationHours: number;
    avgKmPerVehicle: number;
    avgSpeedKmh: number;
    maxSpeedKmh: number;
  };
  alerts: {
    total: number;
    byType: { type: string; count: number }[];
    bySeverity: { severity: string; count: number }[];
  };
  consumption: {
    estimatedLiters: number;
    estimatedCostEur: number;
    fuelPriceEurL: number;
  };
  topVehicles: {
    vehicleId: string;
    plate: string;
    distanceKm: number;
    tripCount: number;
    estimatedConsumptionL: number;
    group: { id: string; name: string } | null;
  }[];
  /**
   * Liste des derniers trajets sur la periode (cap a 30 pour ne pas exploser
   * le PDF). Inclut la note libre + le conducteur — le rapport PDF les rend
   * dans une section dediee "Trajets recents". Trie du plus recent au plus
   * ancien.
   */
  recentTrips: {
    id: string;
    plate: string;
    startedAt: string;
    endedAt: string | null;
    durationSeconds: number;
    distanceKm: number;
    notes: string | null;
    driverName: string | null;
    group: { id: string; name: string } | null;
  }[];
}

@Injectable()
export class ReportsStatsService {
  private readonly logger = new Logger(ReportsStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async compute(
    fleetId: string,
    from: Date,
    to: Date,
    requestedBy?: { role: UserRole | string; fleetId: string | null; accessibleVehicleIds?: string[] | 'ALL' },
    filters?: { vehicleIds?: string[]; maxRecentTrips?: number },
  ): Promise<FleetStatsReport> {
    if (requestedBy && requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (requestedBy.fleetId !== fleetId) {
        throw new ForbiddenException('Acces refuse a cette flotte');
      }
    }

    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId } });
    if (!fleet) throw new NotFoundException('Flotte introuvable');

    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / (24 * 3600 * 1000)));

    // Normalise le filtre vehicleIds demande par l'appelant (filtre groupe /
    // selection multi-vehicules cote front). Liste vide / absente => pas de
    // demande explicite (rapport flotte complet, sauf perimetre user ci-dessous).
    const requestedIds = (filters?.vehicleIds ?? [])
      .map((id) => id?.trim())
      .filter((id): id is string => !!id);
    const uniqueRequestedIds = Array.from(new Set(requestedIds));

    // 🔒 Sprint 5 — borne de PERIMETRE UTILISATEUR (anti-IDOR intra-flotte).
    // Si l'appelant n'a PAS acces a tout (VIEWER/FLEET_MANAGER scope groupe ou
    // vehicules), on borne le rapport a ses vehicules accessibles ET on rejette
    // (403) toute demande explicite hors perimetre — plus strict que l'ancien
    // check « hors flotte ». 'ALL' (admins) => comportement historique.
    // `accessibleVehicleIds` absent (appel interne/cron sans user) => 'ALL'.
    const scope = resolveReportVehicleScope(
      requestedBy?.accessibleVehicleIds ?? 'ALL',
      uniqueRequestedIds,
    );
    const isVehicleScopeRestricted = scope !== 'ALL';
    // Liste effective des vehicleIds qui bornent toutes les requetes ci-dessous.
    const scopedVehicleIds = isVehicleScopeRestricted ? (scope as string[]) : [];

    const vehicles = await this.prisma.vehicle.findMany({
      where: isVehicleScopeRestricted
        ? { fleetId, id: { in: scopedVehicleIds } }
        : { fleetId },
      select: {
        id: true, plate: true, type: true, fuelConsumptionL100km: true,
        // Groupe (unique de-facto) pour l'afficher dans le rapport / PDF.
        groups: {
          select: { group: { select: { id: true, name: true } } },
          orderBy: { group: { name: 'asc' } },
          take: 1,
        },
      },
    });

    // Security check (defense en profondeur, borne FLOTTE) : si une demande
    // explicite de vehicleIds a ete faite, on verifie qu'ils appartiennent tous
    // a la flotte (pour qu'un FLEET_ADMIN ne devine pas des IDs d'une autre
    // flotte). Le perimetre UTILISATEUR (groupe/vehicules) est deja garanti par
    // resolveReportVehicleScope ci-dessus (403 si hors perimetre).
    if (uniqueRequestedIds.length > 0) {
      const foundIds = new Set(vehicles.map((v) => v.id));
      const missing = uniqueRequestedIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          'Un ou plusieurs vehicleIds n\'appartiennent pas a la flotte demandee',
        );
      }
    }

    const totalVehicles = vehicles.length;
    const fuelPrice = fleet.fuelPriceEurL;

    // V1.10 (Sprint 2 perf) — toutes les agregations sont poussees en SQL au
    // lieu de charger tous les trips en memoire + reduce JS. A 30j × 100 vehicules
    // = ~15k trips, on passe d'un payload Prisma ~30 MB en RAM a 4 requetes
    // d'agregation + 1 findMany capee pour le detail "recents".
    //
    // Le filtre vehicleIds (feature d3dca0c) est conserve via tripVehicleFilter
    // injecte dans le where commun.
    const tripVehicleFilter = isVehicleScopeRestricted
      ? { vehicleId: { in: scopedVehicleIds } }
      : {};
    // Mode vie privée (RGPD) : exclut de TOUTES les agrégations les véhicules
    // actuellement en mode privé (trajets + alertes portant une localisation).
    const privacyExclude = { NOT: { vehicle: { privacyModeEnabled: true } } } as const;
    const tripWhere = {
      fleetId,
      ...tripVehicleFilter,
      startedAt: { lte: to },
      endedAt: { gte: from, not: null },
      ...privacyExclude,
    } as const;
    const alertWhere = {
      fleetId,
      createdAt: { gte: from, lte: to },
      // Quand un filtre vehicleIds est actif, les alertes sans vehicleId
      // (ex. tracker isole) sont exclues par definition du sous-ensemble.
      ...(isVehicleScopeRestricted ? { vehicleId: { in: scopedVehicleIds } } : {}),
      ...privacyExclude,
    } as const;
    const recentTripsCap = this.clampRecentTripsCap(filters?.maxRecentTrips);

    // 1) Aggregations globales : sum / avg / max / count en une requete SQL.
    // 2) Group by vehicleId : pour topVehicles + activeVehicleIds.
    // 3) Group by type/severity sur alerts.
    // 4) Detail des 30 trajets recents (avec includes pour le PDF).
    // 5) Group by alerts type + severity.
    const [tripAgg, tripsByVehicle, alertsByType, alertsBySeverity, recentTripsRaw] =
      await Promise.all([
        this.prisma.trip.aggregate({
          where: tripWhere,
          _count: { _all: true },
          _sum: { distanceKm: true, durationSeconds: true },
          _avg: { avgSpeed: true },
          _max: { maxSpeed: true },
        }),
        this.prisma.trip.groupBy({
          by: ['vehicleId'],
          where: tripWhere,
          _sum: { distanceKm: true },
          _count: { _all: true },
        }),
        this.prisma.alert.groupBy({
          by: ['type'],
          where: alertWhere,
          _count: { _all: true },
        }),
        this.prisma.alert.groupBy({
          by: ['severity'],
          where: alertWhere,
          _count: { _all: true },
        }),
        this.prisma.trip.findMany({
          where: tripWhere,
          select: {
            id: true, vehicleId: true, distanceKm: true, durationSeconds: true,
            startedAt: true, endedAt: true,
            notes: true,
            vehicle: {
              select: {
                plate: true,
                groups: {
                  select: { group: { select: { id: true, name: true } } },
                  orderBy: { group: { name: 'asc' } },
                  take: 1,
                },
              },
            },
            driver: { select: { firstName: true, lastName: true } },
          },
          orderBy: { startedAt: 'desc' },
          take: recentTripsCap,
        }),
      ]);

    const tripCount = tripAgg._count._all;
    const totalKm = tripAgg._sum.distanceKm ?? 0;
    const totalSeconds = tripAgg._sum.durationSeconds ?? 0;
    const avgSpeedKmh = tripAgg._avg.avgSpeed ?? 0;
    const maxSpeedKmh = tripAgg._max.maxSpeed ?? 0;
    const activeVehicleIds = new Set(tripsByVehicle.map((g) => g.vehicleId));

    // Map perVehicle pour calcul carburant + top.
    const perVehicle = new Map<string, { distanceKm: number; tripCount: number }>();
    for (const g of tripsByVehicle) {
      perVehicle.set(g.vehicleId, {
        distanceKm: g._sum.distanceKm ?? 0,
        tripCount: g._count._all,
      });
    }

    let totalLiters = 0;
    const topVehicles: FleetStatsReport['topVehicles'] = [];
    for (const v of vehicles) {
      const stat = perVehicle.get(v.id) ?? { distanceKm: 0, tripCount: 0 };
      const consumptionL100 = v.fuelConsumptionL100km
        ?? DEFAULT_CONSUMPTION_L100KM[v.type as keyof typeof DEFAULT_CONSUMPTION_L100KM]
        ?? 8;
      const liters = stat.distanceKm * consumptionL100 / 100;
      totalLiters += liters;
      if (stat.distanceKm > 0) {
        topVehicles.push({
          vehicleId: v.id,
          plate: v.plate,
          distanceKm: Math.round(stat.distanceKm * 10) / 10,
          tripCount: stat.tripCount,
          estimatedConsumptionL: Math.round(liters * 10) / 10,
          group: v.groups?.[0]?.group ?? null,
        });
      }
    }
    topVehicles.sort((a, b) => b.distanceKm - a.distanceKm);

    // V1.10 (Sprint 2 perf) — totalAlerts agrege depuis le groupBy au lieu
    // d'un findMany separe. Le where du groupBy applique deja le filtre
    // vehicleIds (cf. alertWhere ci-dessus).
    const totalAlerts = alertsByType.reduce((sum, g) => sum + g._count._all, 0);

    return {
      fleet: { id: fleet.id, name: fleet.name },
      period: { from: from.toISOString(), to: to.toISOString(), days },
      vehicles: {
        total: totalVehicles,
        activeDuringPeriod: activeVehicleIds.size,
      },
      trips: {
        count: tripCount,
        totalKm: Math.round(totalKm * 10) / 10,
        totalDurationHours: Math.round((totalSeconds / 3600) * 10) / 10,
        avgKmPerVehicle: totalVehicles > 0 ? Math.round((totalKm / totalVehicles) * 10) / 10 : 0,
        avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10,
        maxSpeedKmh: Math.round(maxSpeedKmh * 10) / 10,
      },
      alerts: {
        total: totalAlerts,
        byType: alertsByType.map((g) => ({ type: g.type as string, count: g._count._all })),
        bySeverity: alertsBySeverity.map((g) => ({ severity: g.severity as string, count: g._count._all })),
      },
      consumption: {
        estimatedLiters: Math.round(totalLiters * 10) / 10,
        estimatedCostEur: Math.round(totalLiters * fuelPrice * 100) / 100,
        fuelPriceEurL: fuelPrice,
      },
      topVehicles: topVehicles.slice(0, 10),
      // V1.10 (Sprint 2 perf) — pas de slice ici, le take=recentTripsCap dans
      // le findMany ci-dessus a deja limite cote DB.
      recentTrips: recentTripsRaw.map((t) => ({
        id: t.id,
        plate: t.vehicle?.plate ?? '',
        startedAt: t.startedAt.toISOString(),
        endedAt: t.endedAt?.toISOString() ?? null,
        durationSeconds: t.durationSeconds,
        distanceKm: Math.round(Math.max(0, t.distanceKm) * 10) / 10,
        notes: t.notes ?? null,
        driverName: t.driver ? `${t.driver.firstName} ${t.driver.lastName}` : null,
        group: t.vehicle?.groups?.[0]?.group ?? null,
      })),
    };
  }

  /** Cap defensif sur le nombre de trajets recents embarques dans le rapport.
   *  Default 30 (compat historique) ; jusqu'a 500 quand le caller le demande. */
  private clampRecentTripsCap(requested: number | undefined): number {
    if (requested == null || Number.isNaN(requested)) return 30;
    return Math.min(500, Math.max(1, Math.trunc(requested)));
  }
}
