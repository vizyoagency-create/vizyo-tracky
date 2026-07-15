import { Injectable, NotFoundException } from '@nestjs/common';
import type { FuelStationMapPointDto, FuelStationVisitDto, VehicleFuelReportDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

/** Borne de lecture (perf). */
const MAX_ANALYSES = 20_000;

/**
 * Suivi carburant d'un VÉHICULE (P3) : fréquence des passages en station, prix réellement constatés,
 * et COÛT carburant estimé sur la période — au prix constaté vs au prix paramétré de la flotte (pour
 * montrer au client que les coûts s'appliquent et suivre les améliorations). Lecture seule, scopée
 * anti-IDOR (404 hors périmètre). Aucun appel externe (tout vient de ce qui a déjà été capté).
 */
@Injectable()
export class FuelReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  async vehicleReport(user: AuthUser, vehicleId: string, fromIso?: string, toIso?: string): Promise<VehicleFuelReportDto> {
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, vehicleId))) throw new NotFoundException('Véhicule introuvable');
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 90 * 24 * 3600 * 1000);

    // 1. Passages en station de la période (triés du plus ancien au plus récent).
    const stops = await this.prisma.tripFuelStop.findMany({
      where: { vehicleId, arrivedAt: { gte: from, lte: to } },
      select: { arrivedAt: true, unitPriceEur: true, fuelType: true, station: { select: { id: true, brand: true, city: true, address: true } } },
      orderBy: { arrivedAt: 'asc' },
    });

    const visits = stops.length;
    let avgDaysBetween: number | null = null;
    if (visits >= 2) {
      const spanMs = stops[visits - 1].arrivedAt.getTime() - stops[0].arrivedAt.getTime();
      avgDaysBetween = round(spanMs / (visits - 1) / 86_400_000, 1);
    }

    // Stations distinctes (fréquence + dernier prix capté).
    const byStation = new Map<string, FuelStationVisitDto>();
    for (const s of stops) {
      if (!s.station) continue;
      let e = byStation.get(s.station.id);
      if (!e) {
        e = { stationId: s.station.id, brand: s.station.brand, city: s.station.city, address: s.station.address, visits: 0, lastPriceEur: null };
        byStation.set(s.station.id, e);
      }
      e.visits += 1;
      if (s.unitPriceEur != null) e.lastPriceEur = s.unitPriceEur; // stops asc → dernier = plus récent
    }
    const stations = [...byStation.values()].sort((a, b) => b.visits - a.visits);

    // Prix constatés (pour le carburant du véhicule).
    const priced = stops.filter((s) => s.unitPriceEur != null) as { arrivedAt: Date; unitPriceEur: number }[];
    const prices = priced.map((s) => s.unitPriceEur);
    const priceMin = prices.length ? Math.min(...prices) : null;
    const priceMax = prices.length ? Math.max(...prices) : null;
    const priceAvg = prices.length ? round(prices.reduce((a, b) => a + b, 0) / prices.length, 3) : null;
    const priceLatest = priced.length ? priced[priced.length - 1].unitPriceEur : null;
    const priceTrend = priced.map((s) => ({ at: s.arrivedAt.toISOString(), priceEur: s.unitPriceEur }));
    const fuelType = stops.find((s) => s.fuelType)?.fuelType ?? null;

    // 2. Litres + distance estimés des trajets ANALYSÉS de la période (join analyses→trips par startedAt).
    const analyses = await this.prisma.tripAnalysis.findMany({
      where: { vehicleId }, select: { tripId: true, fuelLiters: true, distanceKm: true },
      orderBy: { computedAt: 'desc' }, take: MAX_ANALYSES,
    });
    const tripIds = analyses.map((a) => a.tripId);
    const trips = tripIds.length
      ? await this.prisma.trip.findMany({ where: { id: { in: tripIds }, startedAt: { gte: from, lte: to } }, select: { id: true } })
      : [];
    const inPeriod = new Set(trips.map((t) => t.id));
    let estimatedLiters = 0;
    let distanceKm = 0;
    for (const a of analyses) {
      if (!inPeriod.has(a.tripId)) continue;
      estimatedLiters += a.fuelLiters ?? 0;
      distanceKm += a.distanceKm;
    }
    estimatedLiters = round(estimatedLiters, 1);
    distanceKm = round(distanceKm, 1);

    // 3. Prix paramétré de la flotte + coûts comparés.
    const veh = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { fleet: { select: { fuelPriceEurL: true } } } });
    const fleetPriceEurL = veh?.fleet?.fuelPriceEurL ?? null;
    const costAtObservedEur = priceAvg != null ? round(estimatedLiters * priceAvg, 2) : null;
    const costAtFleetPriceEur = fleetPriceEurL != null ? round(estimatedLiters * fleetPriceEurL, 2) : null;

    return {
      vehicleId, from: from.toISOString(), to: to.toISOString(),
      visits, avgDaysBetween, stations, fuelType,
      priceMin, priceMax, priceAvg, priceLatest, priceTrend,
      estimatedLiters, distanceKm, costAtObservedEur, costAtFleetPriceEur, fleetPriceEurL,
    };
  }

  /**
   * Stations agrégées pour la CARTE (passages de TOUTE la flotte accessible sur la période) : un point
   * par station avec fréquence + récence + nb de véhicules distincts, pour mettre en avant les stations
   * souvent/récemment utilisées. Scopé au périmètre véhicules (anti-IDOR). Trié par fréquence décroissante.
   */
  async fleetStationsMap(user: AuthUser, fromIso?: string, toIso?: string, fleetId?: string): Promise<FuelStationMapPointDto[]> {
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 90 * 24 * 3600 * 1000);

    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const scopeWhere = accessible === 'ALL'
      ? (fleetId ? { fleetId } : {})
      : { vehicleId: { in: accessible.length ? accessible : ['00000000-0000-0000-0000-000000000000'] } };

    const stops = await this.prisma.tripFuelStop.findMany({
      where: { ...scopeWhere, arrivedAt: { gte: from, lte: to } },
      select: {
        vehicleId: true, arrivedAt: true, unitPriceEur: true, fuelType: true,
        station: { select: { id: true, brand: true, name: true, city: true, address: true, lat: true, lng: true } },
      },
      orderBy: { arrivedAt: 'asc' },
      take: MAX_ANALYSES,
    });

    type Agg = {
      id: string; brand: string | null; name: string | null; city: string | null; address: string | null; lat: number; lng: number;
      visits: number; vehicles: Map<string, number>; lastVisitAt: Date; lastPriceEur: number | null; fuelType: string | null;
    };
    const byStation = new Map<string, Agg>();
    for (const s of stops) {
      if (!s.station) continue;
      let e = byStation.get(s.station.id);
      if (!e) {
        e = { id: s.station.id, brand: s.station.brand, name: s.station.name, city: s.station.city, address: s.station.address, lat: s.station.lat, lng: s.station.lng, visits: 0, vehicles: new Map(), lastVisitAt: s.arrivedAt, lastPriceEur: null, fuelType: null };
        byStation.set(s.station.id, e);
      }
      e.visits += 1;
      // Détail par véhicule : nb de passages de CE véhicule sur CETTE station.
      e.vehicles.set(s.vehicleId, (e.vehicles.get(s.vehicleId) ?? 0) + 1);
      if (s.arrivedAt >= e.lastVisitAt) e.lastVisitAt = s.arrivedAt; // stops asc → dernier = plus récent
      if (s.unitPriceEur != null) { e.lastPriceEur = s.unitPriceEur; e.fuelType = s.fuelType; }
    }

    // Résolution des plaques (TripFuelStop n'a pas de relation Vehicle — join séparé par ids).
    const allVehicleIds = new Set<string>();
    for (const e of byStation.values()) for (const id of e.vehicles.keys()) allVehicleIds.add(id);
    const plateById = new Map<string, string | null>();
    if (allVehicleIds.size) {
      const vs = await this.prisma.vehicle.findMany({
        where: { id: { in: [...allVehicleIds] } },
        select: { id: true, plate: true },
      });
      for (const v of vs) plateById.set(v.id, v.plate);
    }

    return [...byStation.values()]
      .map((e) => ({
        stationId: e.id, brand: e.brand, name: e.name, city: e.city, address: e.address, lat: e.lat, lng: e.lng,
        visits: e.visits, distinctVehicles: e.vehicles.size,
        vehicles: [...e.vehicles.entries()]
          .map(([vehicleId, v]) => ({ vehicleId, plate: plateById.get(vehicleId) ?? null, visits: v }))
          .sort((a, b) => b.visits - a.visits),
        lastVisitAt: e.lastVisitAt.toISOString(), lastPriceEur: e.lastPriceEur, fuelType: e.fuelType,
      }))
      .sort((a, b) => b.visits - a.visits || (a.lastVisitAt < b.lastVisitAt ? 1 : -1));
  }
}

function round(v: number, d: number): number { const f = 10 ** d; return Math.round(v * f) / f; }
