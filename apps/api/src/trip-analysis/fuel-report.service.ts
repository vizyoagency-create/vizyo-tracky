import { tenantVehicleWhere } from '../common/tenant-vehicle-scope';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { FuelStationMapPointDto, FuelStationVisitDto, FuelVisitDto, VehicleFuelReportDto } from '@vizyo/tracky-shared';
import { DORMANT_STOP_COUNTING_MS, formatSilenceLabel, isVehicleDormant, trackerSilenceMs } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

/** Borne de lecture (perf). */
const MAX_ANALYSES = 20_000;

/**
 * Au-delà de ce délai, un relevé de prix cesse d'être « le prix courant ».
 *
 * On réutilise volontairement le seuil « arrêter de COMPTER » (7 j) au lieu d'en inventer un
 * localement : c'est déjà la frontière retenue partout dans l'app entre donnée du présent et donnée
 * d'archive, et un carburant bouge de plusieurs centimes en une semaine. Le cas réel : sur un
 * véhicule muet depuis 89 jours, l'écran affichait « dernier prix 1,88 €/L » exactement comme s'il
 * avait été relevé la veille.
 */
const PRICE_FRESHNESS_MS = DORMANT_STOP_COUNTING_MS;

/** Une station visitée + la DATATION du dernier prix capté, pour ne pas le faire passer pour courant. */
export type FuelStationVisitWithFreshnessDto = FuelStationVisitDto & {
  /** ISO du passage qui a fourni `lastPriceEur`, ou null si aucun prix capté. */
  lastPriceAt: string | null;
  /** true = relevé plus vieux que {@link PRICE_FRESHNESS_MS} → à afficher comme historique, pas comme prix du jour. */
  lastPriceStale: boolean;
};

/**
 * Rapport carburant + l'état de PRÉSENCE du véhicule. Rien n'est retiré du rapport (l'historique
 * reste intégralement consultable, y compris pour un véhicule dormant) : on ajoute de quoi dire à
 * l'écran « ceci est un arrêt sur image d'il y a 89 jours » au lieu de le présenter comme l'actualité.
 */
export type VehicleFuelReportWithDormancyDto = Omit<VehicleFuelReportDto, 'stations'> & {
  stations: FuelStationVisitWithFreshnessDto[];
  /** true = boîtier muet depuis > 7 j : les chiffres ci-dessus ne bougeront plus. */
  dormant: boolean;
  /** Dernier signal du boîtier (ISO), null si aucun boîtier ou boîtier n'ayant jamais émis. */
  trackerLastSeenAt: string | null;
  /** « 89 j » — ancienneté du silence, null si le véhicule n'est pas dormant. */
  silenceLabel: string | null;
  /** ISO du relevé qui a fourni `priceLatest`. */
  priceLatestAt: string | null;
  /** true = `priceLatest` est un prix d'archive, à ne pas afficher comme « prix actuel ». */
  priceLatestStale: boolean;
};

/** Point carte + datation du dernier prix (même règle de fraîcheur que la fiche véhicule). */
export type FuelStationMapPointWithFreshnessDto = FuelStationMapPointDto & {
  lastPriceAt: string | null;
  lastPriceStale: boolean;
};

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

  async vehicleReport(user: AuthUser, vehicleId: string, fromIso?: string, toIso?: string): Promise<VehicleFuelReportWithDormancyDto> {
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, vehicleId))) throw new NotFoundException('Véhicule introuvable');
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 90 * 24 * 3600 * 1000);
    const now = Date.now();

    // 1. Passages en station de la période (triés du plus ancien au plus récent).
    const stops = await this.prisma.tripFuelStop.findMany({
      where: { vehicleId, arrivedAt: { gte: from, lte: to } },
      select: { arrivedAt: true, durationSec: true, unitPriceEur: true, fuelType: true, station: { select: { id: true, brand: true, city: true, address: true } } },
      orderBy: { arrivedAt: 'asc' },
    });

    const visits = stops.length;
    let avgDaysBetween: number | null = null;
    if (visits >= 2) {
      const spanMs = stops[visits - 1].arrivedAt.getTime() - stops[0].arrivedAt.getTime();
      avgDaysBetween = round(spanMs / (visits - 1) / 86_400_000, 1);
    }

    // Stations distinctes (fréquence + dernier prix capté, DATÉ : un prix sans date se lit comme le
    // prix du jour, ce qu'il n'est pas dès que le véhicule ne passe plus).
    const byStation = new Map<string, FuelStationVisitWithFreshnessDto>();
    for (const s of stops) {
      if (!s.station) continue;
      let e = byStation.get(s.station.id);
      if (!e) {
        e = { stationId: s.station.id, brand: s.station.brand, city: s.station.city, address: s.station.address, visits: 0, lastPriceEur: null, lastPriceAt: null, lastPriceStale: false };
        byStation.set(s.station.id, e);
      }
      e.visits += 1;
      // stops asc → dernier = plus récent. On mémorise la date DU RELEVÉ (pas du dernier passage :
      // un passage sans prix capté ne rafraîchit pas le prix).
      if (s.unitPriceEur != null) {
        e.lastPriceEur = s.unitPriceEur;
        e.lastPriceAt = s.arrivedAt.toISOString();
        e.lastPriceStale = isPriceStale(s.arrivedAt, now);
      }
    }
    const stations = [...byStation.values()].sort((a, b) => b.visits - a.visits);

    // Cohérence des passages : km parcourus depuis le passage station PRÉCÉDENT (Σ des trajets entre
    // les deux arrivées). Un vrai plein est espacé de km ; deux passages très proches en km (ou 0 km)
    // trahissent un faux positif (arrêt près d'une station sur une route passante). On surface les
    // derniers passages avec ce signal + la durée d'arrêt pour que l'opérateur juge.
    const COHERENCE_MIN_KM = 15;
    const lastStops = stops.slice(-8);
    const recentVisits: FuelVisitDto[] = [];
    for (let i = 0; i < lastStops.length; i++) {
      const s = lastStops[i];
      const globalIdx = stops.length - lastStops.length + i;
      const prev = globalIdx > 0 ? stops[globalIdx - 1] : null;
      let kmSincePrev: number | null = null;
      if (prev) {
        const agg = await this.prisma.trip.aggregate({
          where: { vehicleId, startedAt: { gt: prev.arrivedAt, lte: s.arrivedAt } },
          _sum: { distanceKm: true },
        });
        kmSincePrev = round(agg._sum.distanceKm ?? 0, 1);
      }
      recentVisits.push({
        at: s.arrivedAt.toISOString(),
        brand: s.station?.brand ?? null,
        city: s.station?.city ?? null,
        priceEur: s.unitPriceEur ?? null,
        durationMin: Math.round((s.durationSec ?? 0) / 60),
        kmSincePrev,
        suspiciouslyClose: kmSincePrev != null && kmSincePrev < COHERENCE_MIN_KM,
      });
    }
    recentVisits.reverse(); // le plus récent en premier

    // Prix constatés (pour le carburant du véhicule).
    const priced = stops.filter((s) => s.unitPriceEur != null) as { arrivedAt: Date; unitPriceEur: number }[];
    const prices = priced.map((s) => s.unitPriceEur);
    const priceMin = prices.length ? Math.min(...prices) : null;
    const priceMax = prices.length ? Math.max(...prices) : null;
    const priceAvg = prices.length ? round(prices.reduce((a, b) => a + b, 0) / prices.length, 3) : null;
    // `priceLatest` = LE chiffre que l'écran présente comme « prix actuel ». On le garde toujours
    // (c'est un fait constaté, on ne masque rien) mais on l'accompagne de sa date et d'un drapeau de
    // péremption, seul moyen de ne pas faire passer un relevé de 89 jours pour le prix d'aujourd'hui.
    const latestPriced = priced.length ? priced[priced.length - 1] : null;
    const priceLatest = latestPriced?.unitPriceEur ?? null;
    const priceLatestAt = latestPriced ? latestPriced.arrivedAt.toISOString() : null;
    const priceLatestStale = isPriceStale(latestPriced?.arrivedAt ?? null, now);
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

    // 3. Prix paramétré de la flotte + coûts comparés. Le boîtier est joint à la requête véhicule
    //    qui existait DÉJÀ : la dormance ne coûte aucune requête de plus (VPS 2 vCPU saturé).
    const veh = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { fleet: { select: { fuelPriceEurL: true } }, tracker: { select: { id: true, lastSeenAt: true } } } });
    const fleetPriceEurL = veh?.fleet?.fuelPriceEurL ?? null;
    const costAtObservedEur = priceAvg != null ? round(estimatedLiters * priceAvg, 2) : null;
    const costAtFleetPriceEur = fleetPriceEurL != null ? round(estimatedLiters * fleetPriceEurL, 2) : null;

    // 4. DORMANCE (seuil « arrêter de COMPTER », 7 j). On ne retire RIEN du rapport : passages,
    // prix et coûts d'un véhicule muet restent affichés — c'est de l'historique, il doit rester
    // consultable. On ajoute seulement de quoi dater l'ensemble, pour que l'écran puisse dire
    // « figé depuis 89 j » au lieu de laisser croire que le suivi continue.
    // Référence = min(maintenant, fin de période) : sur une période PASSÉE demandée explicitement,
    // la question devient « était-il déjà muet à l'époque ? » — sinon un rapport de mars serait
    // marqué dormant parce que le boîtier est tombé en juillet.
    // Source unique `Tracker.lastSeenAt` : ni Trip/Position (jetées en mode vie privée alors que le
    // boîtier parle), ni `Tracker.status` (collant). Aucune écriture, réversible tout seul.
    const dormantAt = Math.min(now, to.getTime());
    const trackerLastSeenAt = veh?.tracker?.lastSeenAt ?? null;
    const dormant = isVehicleDormant({ trackerId: veh?.tracker?.id ?? null, lastSeenAt: trackerLastSeenAt }, dormantAt);

    return {
      vehicleId, from: from.toISOString(), to: to.toISOString(),
      visits, avgDaysBetween, stations, recentVisits, fuelType,
      priceMin, priceMax, priceAvg, priceLatest, priceLatestAt, priceLatestStale, priceTrend,
      estimatedLiters, distanceKm, costAtObservedEur, costAtFleetPriceEur, fleetPriceEurL,
      dormant,
      trackerLastSeenAt: trackerLastSeenAt ? new Date(trackerLastSeenAt).toISOString() : null,
      silenceLabel: dormant ? formatSilenceLabel(trackerLastSeenAt, dormantAt) : null,
    };
  }

  /**
   * Stations agrégées pour la CARTE (passages de TOUTE la flotte accessible sur la période) : un point
   * par station avec fréquence + récence + nb de véhicules distincts, pour mettre en avant les stations
   * souvent/récemment utilisées. Scopé au périmètre véhicules (anti-IDOR). Trié par fréquence décroissante.
   *
   * DORMANCE — décision assumée : les passages d'un véhicule devenu dormant restent comptés ici. Ce
   * n'est pas un classement de véhicules mais l'HISTOIRE d'usage des stations : la station existe,
   * elle a bien été fréquentée, et effacer ces passages ferait disparaître des points de la carte
   * sans que personne ne comprenne pourquoi. Seul le PRIX, lui, est daté et marqué périmé — c'est le
   * seul champ que l'écran présente comme une information du présent.
   */
  async fleetStationsMap(user: AuthUser, fromIso?: string, toIso?: string, fleetId?: string): Promise<FuelStationMapPointWithFreshnessDto[]> {
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 90 * 24 * 3600 * 1000);
    const now = Date.now();

    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    // ⚠️ C'ETAIT LA FUITE. `accessible === 'ALL'` + `fleetId` absent donnait `{}`, donc
    // AUCUN filtre : un FLEET_ADMIN de cdef31 recevait les passages de mh cars, avec les
    // plaques. Le controleur ne transmet `fleetId` qu'aux SUPER_ADMIN — a juste titre —
    // donc la branche permissive etait celle de tous les clients.
    const scopeWhere = tenantVehicleWhere(accessible, user, fleetId);

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
      visits: number; vehicles: Map<string, number>; lastVisitAt: Date; lastPriceEur: number | null; lastPriceAt: Date | null; fuelType: string | null;
    };
    const byStation = new Map<string, Agg>();
    for (const s of stops) {
      if (!s.station) continue;
      let e = byStation.get(s.station.id);
      if (!e) {
        e = { id: s.station.id, brand: s.station.brand, name: s.station.name, city: s.station.city, address: s.station.address, lat: s.station.lat, lng: s.station.lng, visits: 0, vehicles: new Map(), lastVisitAt: s.arrivedAt, lastPriceEur: null, lastPriceAt: null, fuelType: null };
        byStation.set(s.station.id, e);
      }
      e.visits += 1;
      // Détail par véhicule : nb de passages de CE véhicule sur CETTE station.
      e.vehicles.set(s.vehicleId, (e.vehicles.get(s.vehicleId) ?? 0) + 1);
      if (s.arrivedAt >= e.lastVisitAt) e.lastVisitAt = s.arrivedAt; // stops asc → dernier = plus récent
      // Date DU RELEVÉ, distincte du dernier passage : une station revisitée sans prix capté ne
      // « rajeunit » pas son prix. C'est cette date-là qui dit si le prix est encore d'actualité.
      if (s.unitPriceEur != null) { e.lastPriceEur = s.unitPriceEur; e.lastPriceAt = s.arrivedAt; e.fuelType = s.fuelType; }
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
        lastVisitAt: e.lastVisitAt.toISOString(), lastPriceEur: e.lastPriceEur,
        lastPriceAt: e.lastPriceAt ? e.lastPriceAt.toISOString() : null,
        lastPriceStale: isPriceStale(e.lastPriceAt, now),
        fuelType: e.fuelType,
      }))
      .sort((a, b) => b.visits - a.visits || (a.lastVisitAt < b.lastVisitAt ? 1 : -1));
  }
}

/**
 * Un relevé de prix est périmé s'il est plus vieux que {@link PRICE_FRESHNESS_MS}.
 *
 * `null` (aucun prix jamais capté) n'est PAS périmé : il n'y a rien à présenter comme courant, la
 * nuance « inconnu » appartient à l'UI et ne doit pas être écrasée par un « périmé » trompeur.
 * On réutilise `trackerSilenceMs` — c'est le calcul d'ancienneté partagé de l'app, qui ramène à 0
 * les âges négatifs (horloge en avance) et évite un « périmé » calculé sur une date illisible.
 */
function isPriceStale(at: Date | string | number | null | undefined, now: number): boolean {
  const age = trackerSilenceMs(at, now);
  return age != null && age > PRICE_FRESHNESS_MS;
}

function round(v: number, d: number): number { const f = 10 ** d; return Math.round(v * f) / f; }
