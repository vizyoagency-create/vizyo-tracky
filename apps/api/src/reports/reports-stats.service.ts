import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
    requestedBy?: { role: UserRole | string; fleetId: string | null },
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

    // Normalise le filtre vehicleIds : trim, dedup, ignore les chaines vides.
    // Une liste vide ou absente => pas de filtre (rapport flotte complet).
    const requestedIds = (filters?.vehicleIds ?? [])
      .map((id) => id?.trim())
      .filter((id): id is string => !!id);
    const uniqueRequestedIds = Array.from(new Set(requestedIds));
    const isVehicleScopeRestricted = uniqueRequestedIds.length > 0;

    const vehicles = await this.prisma.vehicle.findMany({
      where: isVehicleScopeRestricted
        ? { fleetId, id: { in: uniqueRequestedIds } }
        : { fleetId },
      select: { id: true, plate: true, type: true, fuelConsumptionL100km: true },
    });

    // Security check : si l'utilisateur a demande des vehicleIds inconnus dans
    // sa flotte, on rejette (pour eviter qu'un FLEET_ADMIN devine des IDs
    // appartenant a une autre flotte).
    if (isVehicleScopeRestricted && vehicles.length !== uniqueRequestedIds.length) {
      throw new BadRequestException(
        'Un ou plusieurs vehicleIds n\'appartiennent pas a la flotte demandee',
      );
    }

    const totalVehicles = vehicles.length;
    const fuelPrice = fleet.fuelPriceEurL;

    const tripVehicleFilter = isVehicleScopeRestricted
      ? { vehicleId: { in: uniqueRequestedIds } }
      : {};

    const trips = await this.prisma.trip.findMany({
      where: {
        fleetId,
        ...tripVehicleFilter,
        startedAt: { lte: to },
        endedAt: { gte: from, not: null },
      },
      select: {
        id: true, vehicleId: true, distanceKm: true, durationSeconds: true,
        avgSpeed: true, maxSpeed: true, startedAt: true, endedAt: true,
        notes: true,
        vehicle: { select: { plate: true } },
        driver: { select: { firstName: true, lastName: true } },
      },
      orderBy: { startedAt: 'desc' },
    });

    const tripCount = trips.length;
    const totalKm = trips.reduce((sum, t) => sum + Math.max(0, t.distanceKm), 0);
    const totalSeconds = trips.reduce((sum, t) => sum + Math.max(0, t.durationSeconds), 0);
    const avgSpeedKmh = trips.length > 0
      ? trips.reduce((sum, t) => sum + (t.avgSpeed || 0), 0) / trips.length
      : 0;
    const maxSpeedKmh = trips.reduce((max, t) => Math.max(max, t.maxSpeed || 0), 0);
    const activeVehicleIds = new Set(trips.map((t) => t.vehicleId));

    // Per-vehicle aggregation for "topVehicles" + global consumption.
    const perVehicle = new Map<string, { distanceKm: number; tripCount: number }>();
    for (const t of trips) {
      const cur = perVehicle.get(t.vehicleId) ?? { distanceKm: 0, tripCount: 0 };
      cur.distanceKm += Math.max(0, t.distanceKm);
      cur.tripCount += 1;
      perVehicle.set(t.vehicleId, cur);
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
        });
      }
    }
    topVehicles.sort((a, b) => b.distanceKm - a.distanceKm);

    // Alerts. Quand un filtre vehicleIds est actif, on ne remonte que les
    // alertes rattachees a ces vehicules (les alertes sans vehicleId — ex.
    // tracker isole — sont exclues du sous-ensemble par definition).
    const alerts = await this.prisma.alert.findMany({
      where: {
        fleetId,
        createdAt: { gte: from, lte: to },
        ...(isVehicleScopeRestricted ? { vehicleId: { in: uniqueRequestedIds } } : {}),
      },
      select: { type: true, severity: true },
    });
    const alertTypeMap = new Map<string, number>();
    const alertSevMap = new Map<string, number>();
    for (const a of alerts) {
      alertTypeMap.set(a.type, (alertTypeMap.get(a.type) ?? 0) + 1);
      alertSevMap.set(a.severity, (alertSevMap.get(a.severity) ?? 0) + 1);
    }

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
        total: alerts.length,
        byType: Array.from(alertTypeMap, ([type, count]) => ({ type, count })),
        bySeverity: Array.from(alertSevMap, ([severity, count]) => ({ severity, count })),
      },
      consumption: {
        estimatedLiters: Math.round(totalLiters * 10) / 10,
        estimatedCostEur: Math.round(totalLiters * fuelPrice * 100) / 100,
        fuelPriceEurL: fuelPrice,
      },
      topVehicles: topVehicles.slice(0, 10),
      recentTrips: trips.slice(0, this.clampRecentTripsCap(filters?.maxRecentTrips)).map((t) => ({
        id: t.id,
        plate: t.vehicle?.plate ?? '',
        startedAt: t.startedAt.toISOString(),
        endedAt: t.endedAt?.toISOString() ?? null,
        durationSeconds: t.durationSeconds,
        distanceKm: Math.round(Math.max(0, t.distanceKm) * 10) / 10,
        notes: t.notes ?? null,
        driverName: t.driver ? `${t.driver.firstName} ${t.driver.lastName}` : null,
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
