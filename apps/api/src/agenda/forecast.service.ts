import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type { ForecastResultDto, ForecastSlotDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const FLEET_TZ = 'Europe/Paris';
/** Fenêtre d'apprentissage : on regarde les N dernières semaines de trajets. */
const LOOKBACK_WEEKS = 10;
/** Récurrence retenue si le motif (véhicule × jour) est observé ≥ ce nb de semaines. */
const MIN_ACTIVE_WEEKS = 4;
const MAX_TRIPS = 20_000;
const MAX_DAY_STEPS = 800;
const MAX_SLOTS = 2_000;

const DOW_LABELS = ['', 'lundis', 'mardis', 'mercredis', 'jeudis', 'vendredis', 'samedis', 'dimanches'];
const WEEKDAY_TO_DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Agrégat par (véhicule, jour-de-semaine) : enveloppe horaire par semaine observée. */
interface DowAccum {
  /** weekKey -> { minStart, maxEnd } en heures locales fractionnaires. */
  weeks: Map<number, { minStart: number; maxEnd: number }>;
}

/**
 * Sprint 8 (Palier C) — Moteur de PRÉVISION d'usage récurrent. Détecte, par véhicule et
 * jour-de-semaine, les créneaux où le véhicule roule habituellement (sur les N dernières
 * semaines, heure locale flotte), et les PROJETTE sur la fenêtre demandée comme créneaux
 * INFORMATIFS. Aucune écriture, aucun blocage : un `ForecastSlotDto` n'est pas un événement
 * et ne peut jamais être confondu avec une réservation ferme ni la bloquer. Scope S5 anti-IDOR.
 */
@Injectable()
export class ForecastService {
  private readonly logger = new Logger(ForecastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  private formatter(): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: FLEET_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    });
  }

  private localParts(fmt: Intl.DateTimeFormat, ms: number): { dateKey: string; dow: number; hourFrac: number } {
    const parts = fmt.formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const hour = parseInt(get('hour'), 10) % 24;
    const minute = parseInt(get('minute'), 10);
    return {
      dateKey: `${get('year')}-${get('month')}-${get('day')}`,
      dow: WEEKDAY_TO_DOW[get('weekday')] ?? 1,
      hourFrac: (Number.isNaN(hour) ? 0 : hour) + (Number.isNaN(minute) ? 0 : minute) / 60,
    };
  }

  /** UTC instant correspondant à une heure murale locale (TZ flotte) pour une date donnée. */
  private localWallToUtc(dateKey: string, hourFrac: number): Date {
    const h = Math.max(0, Math.min(23, Math.floor(hourFrac)));
    const m = Math.max(0, Math.min(59, Math.round((hourFrac - h) * 60)));
    const naive = new Date(`${dateKey}T${pad(h)}:${pad(m)}:00Z`);
    const asTz = new Date(naive.toLocaleString('en-US', { timeZone: FLEET_TZ }));
    const asUtc = new Date(naive.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offset = asTz.getTime() - asUtc.getTime();
    return new Date(naive.getTime() - offset);
  }

  private async resolveScope(user: AuthUser): Promise<{ fleetId?: string; ids: string[] | 'ALL' }> {
    let fleetId: string | undefined;
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associee');
      fleetId = user.fleetId;
    }
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const ids = resolveReportVehicleScope(accessible, undefined);
    return { fleetId, ids };
  }

  async getForecast(user: AuthUser, from: Date, to: Date): Promise<ForecastResultDto> {
    const scope = await this.resolveScope(user);

    const learnFrom = new Date(Date.now() - LOOKBACK_WEEKS * WEEK_MS);
    const tripWhere: Prisma.TripWhereInput = { startedAt: { gte: learnFrom } };
    if (scope.fleetId) tripWhere.fleetId = scope.fleetId;
    if (scope.ids !== 'ALL') tripWhere.vehicleId = { in: scope.ids };

    const trips = await this.prisma.trip.findMany({
      where: tripWhere,
      select: { vehicleId: true, startedAt: true, endedAt: true, vehicle: { select: { plate: true } } },
      orderBy: { startedAt: 'asc' },
      take: MAX_TRIPS,
    });
    if (trips.length >= MAX_TRIPS) {
      this.logger.warn(`getForecast: ${MAX_TRIPS} trajets atteints (apprentissage tronqué).`);
    }

    const fmt = this.formatter();
    // vehicleId -> plate
    const plates = new Map<string, string | null>();
    // vehicleId -> dow -> DowAccum
    const byVehicle = new Map<string, Map<number, DowAccum>>();

    for (const t of trips) {
      plates.set(t.vehicleId, t.vehicle?.plate ?? null);
      const startMs = t.startedAt.getTime();
      const { dateKey, dow, hourFrac: startH } = this.localParts(fmt, startMs);
      // Heure de fin locale (même journée d'ancrage = le jour de DÉBUT, pour ne pas
      // éclater un trajet nocturne sur 2 jours côté prévision).
      const endH = t.endedAt ? Math.max(startH, this.localParts(fmt, t.endedAt.getTime()).hourFrac) : startH + 1;
      const weekKey = Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / WEEK_MS);

      let dows = byVehicle.get(t.vehicleId);
      if (!dows) {
        dows = new Map();
        byVehicle.set(t.vehicleId, dows);
      }
      let acc = dows.get(dow);
      if (!acc) {
        acc = { weeks: new Map() };
        dows.set(dow, acc);
      }
      const wk = acc.weeks.get(weekKey);
      if (!wk) acc.weeks.set(weekKey, { minStart: startH, maxEnd: endH });
      else {
        wk.minStart = Math.min(wk.minStart, startH);
        wk.maxEnd = Math.max(wk.maxEnd, endH);
      }
    }

    // Motifs récurrents : (véhicule, dow) observé sur ≥ MIN_ACTIVE_WEEKS semaines.
    interface Pattern { vehicleId: string; dow: number; typStart: number; typEnd: number; activeWeeks: number }
    const patterns: Pattern[] = [];
    for (const [vehicleId, dows] of byVehicle) {
      for (const [dow, acc] of dows) {
        const activeWeeks = acc.weeks.size;
        if (activeWeeks < MIN_ACTIVE_WEEKS) continue;
        let sumStart = 0;
        let sumEnd = 0;
        for (const w of acc.weeks.values()) {
          sumStart += w.minStart;
          sumEnd += w.maxEnd;
        }
        patterns.push({
          vehicleId,
          dow,
          typStart: sumStart / activeWeeks,
          typEnd: Math.min(23.98, sumEnd / activeWeeks), // borne : évite le 24:00 -> 23:59 du projeté
          activeWeeks,
        });
      }
    }

    // Projection sur [from, to] : chaque date de la fenêtre qui matche le dow d'un motif.
    const patternsByDow = new Map<number, Pattern[]>();
    for (const p of patterns) {
      const list = patternsByDow.get(p.dow) ?? [];
      list.push(p);
      patternsByDow.set(p.dow, list);
    }

    const slots: ForecastSlotDto[] = [];
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const seenDates = new Set<string>();
    let cursor = fromMs;
    let steps = 0;
    while (cursor < toMs && steps < MAX_DAY_STEPS && slots.length < MAX_SLOTS) {
      const { dateKey, dow } = this.localParts(fmt, cursor);
      if (!seenDates.has(dateKey)) {
        seenDates.add(dateKey);
        const ps = patternsByDow.get(dow);
        if (ps) {
          for (const p of ps) {
            if (slots.length >= MAX_SLOTS) break;
            slots.push({
              vehicleId: p.vehicleId,
              vehiclePlate: plates.get(p.vehicleId) ?? null,
              startAt: this.localWallToUtc(dateKey, p.typStart).toISOString(),
              endAt: this.localWallToUtc(dateKey, p.typEnd).toISOString(),
              dayOfWeek: dow,
              basis: `${p.activeWeeks}/${LOOKBACK_WEEKS} ${DOW_LABELS[dow]}`,
              confidence: Math.round((p.activeWeeks / LOOKBACK_WEEKS) * 100) / 100,
            });
          }
        }
      }
      cursor += 12 * 60 * 60 * 1000; // pas de 12h (robuste DST), dédup par dateKey
      steps++;
    }

    return { from: from.toISOString(), to: to.toISOString(), slots };
  }
}
