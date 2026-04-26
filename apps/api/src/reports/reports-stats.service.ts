import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  ): Promise<FleetStatsReport> {
    if (requestedBy && requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (requestedBy.fleetId !== fleetId) {
        throw new ForbiddenException('Acces refuse a cette flotte');
      }
    }

    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId } });
    if (!fleet) throw new NotFoundException('Flotte introuvable');

    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / (24 * 3600 * 1000)));

    const vehicles = await this.prisma.vehicle.findMany({
      where: { fleetId },
      select: { id: true, plate: true, type: true, fuelConsumptionL100km: true },
    });
    const totalVehicles = vehicles.length;
    const fuelPrice = fleet.fuelPriceEurL;

    const trips = await this.prisma.trip.findMany({
      where: {
        fleetId,
        startedAt: { lte: to },
        endedAt: { gte: from, not: null },
      },
      select: {
        id: true, vehicleId: true, distanceKm: true, durationSeconds: true,
        avgSpeed: true, maxSpeed: true, startedAt: true, endedAt: true,
      },
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

    // Alerts.
    const alerts = await this.prisma.alert.findMany({
      where: { fleetId, createdAt: { gte: from, lte: to } },
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
    };
  }
}
