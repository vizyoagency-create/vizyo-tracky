import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { FuelConfidence, FuelFillUpDto, UpsertFuelFillUpDto, VehicleFuelModelDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { fuelTypeFor } from './fuel-station.service';

/** Conso par défaut (L/100km) par type — aligné reports/excel. */
const DEFAULT_CONSUMPTION_L100KM: Record<string, number> = {
  CAR: 7, TRUCK: 22, VAN: 10, MOTORCYCLE: 4, BICYCLE: 0, BUS: 28, CONSTRUCTION: 18, OTHER: 8,
};
/** Distance minimale entre 2 pleins pour une mesure fiable (km). */
const MIN_TANK_KM = 10;
/** Bornes de plausibilité d'une conso mesurée (rejette pleins partiels mal étiquetés / erreurs). */
const MIN_CONS = 1;
const MAX_CONS = 60;

type FillRow = {
  id: string; vehicleId: string; filledAt: Date; litersFilled: number; amountPaidEur: number | null;
  fullTank: boolean; odometerKm: number | null; fuelType: string | null; stationId: string | null; note: string | null;
  station: { brand: string | null; city: string | null } | null;
};

/**
 * Calibration carburant « MÉTHODE DU PLEIN » (2026-07). À partir des pleins RENSEIGNÉS (litres réels),
 * déduit la consommation RÉELLE d'un véhicule = litres / distance entre 2 pleins COMPLETS (odomètre si
 * dispo, sinon somme des trajets). La conso calibrée est stockée sur le véhicule et PRIME partout →
 * l'app devient précise « au fur et à mesure ». Fournit aussi le modèle coût (conso effective × prix
 * réellement constaté) pour que le client fasse confiance aux chiffres. Scoping anti-IDOR.
 */
@Injectable()
export class FuelCalibrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  // ── Lecture ────────────────────────────────────────────────────────────────

  /** Pleins d'un véhicule sur la période, avec distance + conso mesurée dérivées. */
  async listFillUps(user: AuthUser, vehicleId: string, fromIso?: string, toIso?: string): Promise<FuelFillUpDto[]> {
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, vehicleId))) throw new NotFoundException('Véhicule introuvable');
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 365 * 24 * 3600 * 1000);
    const fills = await this.loadFills(vehicleId); // tous (pour dériver la distance depuis le plein précédent)
    const derived = await this.derive(vehicleId, fills);
    return derived.filter((d) => { const t = new Date(d.filledAt).getTime(); return t >= from.getTime() && t <= to.getTime(); });
  }

  /** Modèle carburant calibré + coûts d'un véhicule. */
  async vehicleModel(user: AuthUser, vehicleId: string, fromIso?: string, toIso?: string): Promise<VehicleFuelModelDto> {
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, vehicleId))) throw new NotFoundException('Véhicule introuvable');
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 90 * 24 * 3600 * 1000);

    const veh = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { type: true, energy: true, fuelConsumptionL100km: true, calibratedConsumptionL100km: true, calibratedTanks: true, fleet: { select: { fuelPriceEurL: true } } },
    });
    if (!veh) throw new NotFoundException('Véhicule introuvable');

    const estimated = veh.fuelConsumptionL100km ?? DEFAULT_CONSUMPTION_L100KM[veh.type] ?? 8;
    const calibrated = veh.calibratedTanks > 0 ? veh.calibratedConsumptionL100km : null;
    const effective = calibrated ?? estimated;
    const consumptionSource: VehicleFuelModelDto['consumptionSource'] = calibrated != null ? 'calibrated' : (veh.fuelConsumptionL100km != null ? 'vehicle' : 'default');
    const fuelType = fuelTypeFor(veh.energy);

    // Distance de la période (trajets).
    const trips = await this.prisma.trip.aggregate({ where: { vehicleId, startedAt: { gte: from, lte: to } }, _sum: { distanceKm: true } });
    const distanceKm = round1(trips._sum.distanceKm ?? 0);
    const effectiveLiters = round1((distanceKm * effective) / 100);

    // Prix réellement constaté en station sur la période (moyenne des passages).
    const stopAgg = await this.prisma.tripFuelStop.aggregate({ where: { vehicleId, arrivedAt: { gte: from, lte: to }, unitPriceEur: { not: null } }, _avg: { unitPriceEur: true } });
    const observedPriceEurL = stopAgg._avg.unitPriceEur != null ? round3(stopAgg._avg.unitPriceEur) : null;
    const fleetPriceEurL = veh.fleet?.fuelPriceEurL ?? null;

    // Pleins réels de la période.
    const allFills = await this.loadFills(vehicleId);
    const derived = await this.derive(vehicleId, allFills);
    const inPeriod = derived.filter((d) => { const t = new Date(d.filledAt).getTime(); return t >= from.getTime() && t <= to.getTime(); });
    const measuredTanks = derived.filter((d) => d.realConsumptionL100km != null).length;
    const realLiters = inPeriod.length ? round1(inPeriod.reduce((s, d) => s + d.litersFilled, 0)) : null;
    const paid = inPeriod.filter((d) => d.amountPaidEur != null);
    const realSpentEur = paid.length ? round2(paid.reduce((s, d) => s + (d.amountPaidEur as number), 0)) : null;

    return {
      vehicleId, from: from.toISOString(), to: to.toISOString(),
      estimatedConsumptionL100km: round1(estimated),
      calibratedConsumptionL100km: calibrated != null ? round1(calibrated) : null,
      effectiveConsumptionL100km: round1(effective),
      consumptionSource, fuelType,
      fillUpCount: inPeriod.length, measuredTanks, confidence: confidenceFor(veh.calibratedTanks),
      distanceKm, effectiveLiters, observedPriceEurL, fleetPriceEurL,
      costAtObservedEur: observedPriceEurL != null ? round2(effectiveLiters * observedPriceEurL) : null,
      costAtFleetPriceEur: fleetPriceEurL != null ? round2(effectiveLiters * fleetPriceEurL) : null,
      realLiters, realSpentEur,
      deltaPercent: calibrated != null && estimated > 0 ? Math.round(((calibrated - estimated) / estimated) * 1000) / 10 : null,
      fillUps: inPeriod,
    };
  }

  // ── Écriture (CRUD plein) ────────────────────────────────────────────────

  async createFillUp(user: AuthUser, dto: UpsertFuelFillUpDto): Promise<FuelFillUpDto> {
    const veh = await this.assertVehicle(user, dto.vehicleId);
    const data = this.sanitize(dto);
    const created = await this.prisma.fuelFillUp.create({
      data: { ...data, vehicleId: dto.vehicleId, fleetId: veh.fleetId, createdByUserId: user.id ?? null },
      select: FILL_SELECT,
    });
    await this.recalibrate(dto.vehicleId);
    return (await this.deriveOne(dto.vehicleId, created)) ?? this.toDto(created, null, null);
  }

  async updateFillUp(user: AuthUser, id: string, dto: UpsertFuelFillUpDto): Promise<FuelFillUpDto> {
    const existing = await this.prisma.fuelFillUp.findUnique({ where: { id }, select: { vehicleId: true } });
    if (!existing) throw new NotFoundException('Plein introuvable');
    await this.assertVehicle(user, existing.vehicleId);
    const data = this.sanitize(dto);
    const updated = await this.prisma.fuelFillUp.update({ where: { id }, data, select: FILL_SELECT });
    await this.recalibrate(existing.vehicleId);
    return (await this.deriveOne(existing.vehicleId, updated)) ?? this.toDto(updated, null, null);
  }

  async deleteFillUp(user: AuthUser, id: string): Promise<{ ok: true }> {
    const existing = await this.prisma.fuelFillUp.findUnique({ where: { id }, select: { vehicleId: true } });
    if (!existing) throw new NotFoundException('Plein introuvable');
    await this.assertVehicle(user, existing.vehicleId);
    await this.prisma.fuelFillUp.delete({ where: { id } });
    await this.recalibrate(existing.vehicleId);
    return { ok: true };
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  private async assertVehicle(user: AuthUser, vehicleId: string): Promise<{ fleetId: string }> {
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, vehicleId))) throw new NotFoundException('Véhicule introuvable');
    const veh = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { fleetId: true, privacyModeEnabled: true } });
    if (!veh?.fleetId) throw new NotFoundException('Véhicule introuvable');
    if (veh.privacyModeEnabled) throw new BadRequestException('Véhicule en mode vie privée : saisie carburant indisponible.');
    return { fleetId: veh.fleetId };
  }

  private sanitize(dto: UpsertFuelFillUpDto) {
    const liters = Number(dto.litersFilled);
    if (!Number.isFinite(liters) || liters <= 0 || liters > 2000) throw new BadRequestException('Litres invalides.');
    const filledAt = new Date(dto.filledAt);
    if (Number.isNaN(filledAt.getTime())) throw new BadRequestException('Date invalide.');
    const amount = dto.amountPaidEur == null ? null : Number(dto.amountPaidEur);
    const odo = dto.odometerKm == null ? null : Number(dto.odometerKm);
    return {
      filledAt, litersFilled: Math.round(liters * 100) / 100,
      amountPaidEur: amount != null && Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null,
      fullTank: dto.fullTank !== false,
      odometerKm: odo != null && Number.isFinite(odo) && odo >= 0 ? Math.round(odo * 10) / 10 : null,
      fuelType: dto.fuelType ?? null,
      stationId: dto.stationId ?? null,
      note: dto.note ? String(dto.note).slice(0, 300) : null,
    };
  }

  private async loadFills(vehicleId: string): Promise<FillRow[]> {
    return this.prisma.fuelFillUp.findMany({ where: { vehicleId }, orderBy: { filledAt: 'asc' }, select: FILL_SELECT }) as unknown as Promise<FillRow[]>;
  }

  /** Distance entre 2 pleins : odomètre si les 2 relevés existent (+cohérents), sinon somme des trajets. */
  private async distanceBetween(vehicleId: string, prev: FillRow, cur: FillRow): Promise<number | null> {
    if (prev.odometerKm != null && cur.odometerKm != null && cur.odometerKm > prev.odometerKm) {
      return round1(cur.odometerKm - prev.odometerKm);
    }
    const agg = await this.prisma.trip.aggregate({ where: { vehicleId, startedAt: { gt: prev.filledAt, lte: cur.filledAt } }, _sum: { distanceKm: true } });
    const d = agg._sum.distanceKm ?? 0;
    return d > 0 ? round1(d) : null;
  }

  /** Enrichit chaque plein : distance depuis le précédent PLEIN COMPLET + conso mesurée + prix unitaire. */
  private async derive(vehicleId: string, fills: FillRow[]): Promise<FuelFillUpDto[]> {
    const out: FuelFillUpDto[] = [];
    let lastFull: FillRow | null = null;
    for (const f of fills) {
      let distanceSinceKm: number | null = null;
      let realConsumptionL100km: number | null = null;
      if (lastFull) {
        distanceSinceKm = await this.distanceBetween(vehicleId, lastFull, f);
        // Conso mesurable seulement entre 2 PLEINS COMPLETS (les litres = ce qui a été consommé).
        if (f.fullTank && lastFull.fullTank && distanceSinceKm != null && distanceSinceKm >= MIN_TANK_KM) {
          const c = (f.litersFilled / distanceSinceKm) * 100;
          if (c >= MIN_CONS && c <= MAX_CONS) realConsumptionL100km = round1(c);
        }
      }
      const unitPriceEur = f.amountPaidEur != null && f.litersFilled > 0 ? round3(f.amountPaidEur / f.litersFilled) : null;
      out.push(this.toDto(f, distanceSinceKm, realConsumptionL100km, unitPriceEur));
      if (f.fullTank) lastFull = f;
    }
    return out;
  }

  private async deriveOne(vehicleId: string, f: FillRow): Promise<FuelFillUpDto | null> {
    const all = await this.loadFills(vehicleId);
    const derived = await this.derive(vehicleId, all);
    return derived.find((d) => d.id === f.id) ?? null;
  }

  /**
   * Recalcule la conso RÉELLE du véhicule (méthode du plein) et la stocke : consommation = Σ litres des
   * pleins complets mesurés / Σ distances × 100 (moyenne pondérée par la distance = vraie conso flotte).
   */
  private async recalibrate(vehicleId: string): Promise<void> {
    const fills = await this.loadFills(vehicleId);
    let sumLiters = 0;
    let sumDist = 0;
    let tanks = 0;
    let lastFull: FillRow | null = null;
    for (const f of fills) {
      if (lastFull && f.fullTank && lastFull.fullTank) {
        const d = await this.distanceBetween(vehicleId, lastFull, f);
        if (d != null && d >= MIN_TANK_KM) {
          const c = (f.litersFilled / d) * 100;
          if (c >= MIN_CONS && c <= MAX_CONS) { sumLiters += f.litersFilled; sumDist += d; tanks += 1; }
        }
      }
      if (f.fullTank) lastFull = f;
    }
    const calibrated = tanks > 0 && sumDist > 0 ? Math.round((sumLiters / sumDist) * 1000) / 10 : null; // L/100km, 1 déc.
    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { calibratedConsumptionL100km: calibrated, calibratedTanks: tanks, calibratedAt: tanks > 0 ? new Date() : null },
    }).catch(() => { /* best-effort */ });
  }

  private toDto(f: FillRow, distanceSinceKm: number | null, realConsumptionL100km: number | null, unitPriceEur: number | null = null): FuelFillUpDto {
    return {
      id: f.id, vehicleId: f.vehicleId, filledAt: f.filledAt.toISOString(),
      litersFilled: f.litersFilled, amountPaidEur: f.amountPaidEur, fullTank: f.fullTank,
      odometerKm: f.odometerKm, fuelType: f.fuelType, stationId: f.stationId,
      stationLabel: f.station ? [f.station.brand, f.station.city].filter(Boolean).join(' · ') || null : null,
      note: f.note, distanceSinceKm, realConsumptionL100km,
      unitPriceEur: unitPriceEur ?? (f.amountPaidEur != null && f.litersFilled > 0 ? round3(f.amountPaidEur / f.litersFilled) : null),
    };
  }
}

const FILL_SELECT = {
  id: true, vehicleId: true, filledAt: true, litersFilled: true, amountPaidEur: true, fullTank: true,
  odometerKm: true, fuelType: true, stationId: true, note: true,
  station: { select: { brand: true, city: true } },
} as const;

function confidenceFor(tanks: number): FuelConfidence {
  if (tanks <= 0) return 'none';
  if (tanks === 1) return 'low';
  if (tanks <= 3) return 'medium';
  return 'high';
}
function round1(v: number): number { return Math.round(v * 10) / 10; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }
