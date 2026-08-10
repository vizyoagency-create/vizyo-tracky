import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type {
  FleetOptimizationDto,
  UtilizationCellDto,
  UtilizationSlot,
  VehicleActivitySlotDto,
  VehicleAvailabilityDto,
  VehicleUtilizationDto,
} from '@vizyo/tracky-shared';
import { DORMANT_STOP_COUNTING_MS, formatSilenceLabel, isVehicleDormant } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

const HOUR_MS = 60 * 60 * 1000;
/** Fuseau de référence pour le bucketing « tous les lundis 10h » (≠ UTC brut). */
const FLEET_TZ = 'Europe/Paris';
/** Bornes défensives (volume prod ~6,7k trajets ; la fenêtre temporelle borne déjà). */
const MAX_TRIPS = 20_000;
const MAX_VEHICLES = 5_000;
/** Cap d'itération horaire par trajet (14 j) — un trajet anormalement long ne boucle pas. */
const MAX_HOUR_STEPS = 24 * 14;
const MAX_DAY_STEPS = 800;
/** < 12 % des heures de la fenêtre actives → sous-utilisé (candidat mutualisation). */
const UNDERUTILIZED_RATIO = 0.12;
/** ≤ 5 % d'occupation sur ≥ 2 occurrences → créneau « libre » récurrent. */
const FREE_PATTERN_MAX_OCCUPANCY = 0.05;
const FREE_PATTERN_MIN_OCCURRENCES = 2;
const MAX_FREE_PATTERNS = 6;

const DOW_LABELS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const SLOT_LABELS: Record<UtilizationSlot, string> = {
  night: 'nuit',
  morning: 'matin',
  afternoon: 'après-midi',
  evening: 'soir',
};
const WEEKDAY_TO_DOW: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

function slotOfHour(hour: number): UtilizationSlot {
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

interface VehicleAccum {
  plate: string | null;
  tripCount: number;
  activeMs: number;
  distanceKm: number;
  activeDays: Set<string>;
  /** `${dow}:${slot}` -> dates distinctes (heure locale) où le véhicule était actif. */
  cellDates: Map<string, Set<string>>;
}

type ResolvedScope = { fleetId?: string; ids: string[] | 'ALL' };

/**
 * Ligne d'utilisation ENRICHIE de la dormance.
 *
 * `dormant` / `silenceLabel` ne sont pas (encore) déclarés dans `VehicleUtilizationDto`, qui
 * appartient à un autre lot : les émettre en plus est purement ADDITIF (aucun consommateur
 * existant ne casse), et c'est le seul moyen de dire à l'écran POURQUOI un véhicule à 0 %
 * n'est plus étiqueté « sous-utilisé ». Sans ça, on aurait juste fait disparaître un badge
 * en silence — exactement ce qu'il ne faut pas faire à un chiffre affiché au client.
 */
export type VehicleUtilizationRow = VehicleUtilizationDto & {
  /** Boîtier muet depuis plus de 7 j : le véhicule est INJOIGNABLE, pas « peu utilisé ». */
  dormant: boolean;
  /** Ancienneté du silence prête à afficher (« 89 j »), null si le véhicule n'est pas dormant. */
  silenceLabel: string | null;
};

/** Reste assignable à `FleetOptimizationDto` : les consommateurs actuels ne voient rien changer. */
export type FleetUtilizationResult = Omit<FleetOptimizationDto, 'vehicles'> & {
  vehicles: VehicleUtilizationRow[];
  /** Nombre de véhicules requalifiés « dormants » dans cette réponse (jamais retirés de la liste). */
  dormantCount: number;
};

/**
 * Sprint 8 (Palier A) — Visibilité flotte en LECTURE SEULE, dérivée des trajets.
 * Scoping tenant STRICT réutilisant la chaîne S5 (`getAccessibleVehicleIds` +
 * `resolveReportVehicleScope`). Aucune écriture. Bornée en perf (fenêtre + caps).
 */
@Injectable()
export class FleetInsightsService {
  private readonly logger = new Logger(FleetInsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  /** Construit un formateur de date en heure locale flotte (réutilisé). */
  private localFormatter(): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: FLEET_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
      weekday: 'short',
    });
  }

  private localParts(fmt: Intl.DateTimeFormat, ms: number): { dateKey: string; dow: number; hour: number } {
    const parts = fmt.formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const hour = parseInt(get('hour'), 10) % 24; // '24' (minuit) -> 0
    return {
      dateKey: `${get('year')}-${get('month')}-${get('day')}`,
      dow: WEEKDAY_TO_DOW[get('weekday')] ?? 1,
      hour: Number.isNaN(hour) ? 0 : hour,
    };
  }

  /** Résout le périmètre (flotte + véhicules accessibles), avec filtre véhicule/groupe/flotte optionnel. */
  private async resolveScope(
    user: AuthUser,
    filter?: { vehicleId?: string; groupId?: string; fleetId?: string },
  ): Promise<ResolvedScope | null> {
    let fleetId: string | undefined;
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (!user.fleetId) throw new ForbiddenException('Aucune flotte associée');
      fleetId = user.fleetId;
    } else if (filter?.fleetId) {
      fleetId = filter.fleetId; // filtre société global (SUPER_ADMIN)
    }

    let requested: string[] | undefined;
    if (filter?.vehicleId) requested = [filter.vehicleId];
    else if (filter?.groupId) {
      requested = await this.groupVehicleIds(user, filter.groupId);
      if (requested.length === 0) return null; // groupe vide -> rien à exposer
    }

    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const ids = resolveReportVehicleScope(accessible, requested); // 403 si hors périmètre
    return { fleetId, ids };
  }

  private async groupVehicleIds(user: AuthUser, groupId: string): Promise<string[]> {
    const assignments = await this.prisma.vehicleGroupAssignment.findMany({
      where: {
        groupId,
        ...(user.role !== UserRole.SUPER_ADMIN
          ? { group: { fleetId: user.fleetId ?? '__none__' } }
          : {}),
      },
      select: { vehicleId: true },
    });
    return assignments.map((a) => a.vehicleId);
  }

  private async fetchTrips(scope: ResolvedScope, from: Date, to: Date) {
    const where: Prisma.TripWhereInput = {
      // Chevauchement [from,to] : commencé avant la fin ET (en cours OU fini après le début).
      startedAt: { lt: to },
      OR: [{ endedAt: null }, { endedAt: { gt: from } }],
    };
    if (scope.fleetId) where.fleetId = scope.fleetId;
    if (scope.ids !== 'ALL') where.vehicleId = { in: scope.ids };

    return this.prisma.trip.findMany({
      where,
      select: {
        vehicleId: true,
        startedAt: true,
        endedAt: true,
        distanceKm: true,
        vehicle: { select: { plate: true } },
      },
      orderBy: { startedAt: 'asc' },
      take: MAX_TRIPS,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Activité / disponibilité réelle
  // ───────────────────────────────────────────────────────────────────────────

  async getAvailability(
    user: AuthUser,
    from: Date,
    to: Date,
    filter?: { vehicleId?: string; groupId?: string; fleetId?: string },
  ): Promise<VehicleAvailabilityDto> {
    const scope = await this.resolveScope(user, filter);
    if (!scope) return { from: from.toISOString(), to: to.toISOString(), slots: [], truncated: false };

    const trips = await this.fetchTrips(scope, from, to);
    const truncated = trips.length >= MAX_TRIPS;
    if (truncated) {
      this.logger.warn(`getAvailability: ${MAX_TRIPS} trajets atteints (résultat tronqué), fenêtre à réduire.`);
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const slots: VehicleActivitySlotDto[] = trips.map((t) => {
      const startMs = Math.max(t.startedAt.getTime(), fromMs);
      const endMs = t.endedAt ? Math.min(t.endedAt.getTime(), toMs) : null;
      return {
        vehicleId: t.vehicleId,
        vehiclePlate: t.vehicle?.plate ?? null,
        startAt: new Date(startMs).toISOString(),
        endAt: endMs !== null ? new Date(endMs).toISOString() : null,
        ongoing: t.endedAt === null,
        distanceKm: Math.round((t.distanceKm ?? 0) * 10) / 10,
      };
    });

    return { from: from.toISOString(), to: to.toISOString(), slots, truncated };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Utilisation / optimisation
  // ───────────────────────────────────────────────────────────────────────────

  async getUtilization(
    user: AuthUser,
    from: Date,
    to: Date,
    filter?: { vehicleId?: string; groupId?: string; fleetId?: string },
  ): Promise<FleetUtilizationResult> {
    const scope = await this.resolveScope(user, filter);
    if (!scope) {
      return { from: from.toISOString(), to: to.toISOString(), periodDays: 0, vehicles: [], dormantCount: 0 };
    }

    // Tous les véhicules du périmètre (inclut ceux sans trajet = 0 % utilisé = priorité mutualisation).
    // `tracker.lastSeenAt` est joint ICI (pas dans une seconde requête) : il tranche entre « peu
    // utilisé » et « plus joignable », deux situations que 0 % d'utilisation ne distingue pas.
    const vehWhere: Prisma.VehicleWhereInput = {};
    if (scope.fleetId) vehWhere.fleetId = scope.fleetId;
    if (scope.ids !== 'ALL') vehWhere.id = { in: scope.ids };
    const vehicles = await this.prisma.vehicle.findMany({
      where: vehWhere,
      select: { id: true, plate: true, tracker: { select: { id: true, lastSeenAt: true } } },
      take: MAX_VEHICLES,
    });

    const trips = await this.fetchTrips(scope, from, to);
    const fmt = this.localFormatter();
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const nowMs = Date.now();
    // Le numérateur (activeMs) ne court que jusqu'à maintenant ; on borne AUSSI le dénominateur
    // à `now` pour ne pas déflater l'occupation quand la fenêtre `to` est dans le futur.
    const effectiveToMs = Math.min(toMs, nowMs);

    // Dénominateur : occurrences de chaque jour-de-semaine sur la fenêtre + total jours.
    const dowOccurrences = new Map<number, number>();
    const seenDates = new Set<string>();
    let dayCursor = fromMs;
    let daySteps = 0;
    while (dayCursor < effectiveToMs && daySteps < MAX_DAY_STEPS) {
      const { dateKey, dow } = this.localParts(fmt, dayCursor);
      if (!seenDates.has(dateKey)) {
        seenDates.add(dateKey);
        dowOccurrences.set(dow, (dowOccurrences.get(dow) ?? 0) + 1);
      }
      dayCursor += 12 * HOUR_MS; // pas de 12h : on touche chaque date même autour d'un saut DST
      daySteps++;
    }
    const periodDays = seenDates.size;

    const accum = new Map<string, VehicleAccum>();
    for (const v of vehicles) {
      accum.set(v.id, {
        plate: v.plate,
        tripCount: 0,
        activeMs: 0,
        distanceKm: 0,
        activeDays: new Set(),
        cellDates: new Map(),
      });
    }

    for (const t of trips) {
      const a = accum.get(t.vehicleId);
      if (!a) continue; // trajet d'un véhicule hors liste (ne devrait pas arriver, scope identique)
      a.tripCount++;
      a.distanceKm += t.distanceKm ?? 0;

      const startMs = Math.max(t.startedAt.getTime(), fromMs);
      const endMs = Math.min(t.endedAt ? t.endedAt.getTime() : nowMs, effectiveToMs);
      if (endMs <= startMs) continue;
      a.activeMs += endMs - startMs;

      // Échantillonnage horaire des cellules (jour-de-semaine × créneau) traversées.
      let cursor = startMs;
      let steps = 0;
      while (cursor < endMs && steps < MAX_HOUR_STEPS) {
        const { dateKey, dow, hour } = this.localParts(fmt, cursor);
        a.activeDays.add(dateKey);
        const cellKey = `${dow}:${slotOfHour(hour)}`;
        let set = a.cellDates.get(cellKey);
        if (!set) {
          set = new Set();
          a.cellDates.set(cellKey, set);
        }
        set.add(dateKey);
        cursor += HOUR_MS;
        steps++;
      }
    }

    const windowMs = Math.max(1, effectiveToMs - fromMs);
    const slotOrder: UtilizationSlot[] = ['night', 'morning', 'afternoon', 'evening'];

    const out: VehicleUtilizationRow[] = vehicles.map((v) => {
      const a = accum.get(v.id)!;
      const cells: UtilizationCellDto[] = [];
      const freePatterns: string[] = [];
      const hasActivity = a.tripCount > 0;
      // « Sous-utilisé » est un CONSEIL D'EXPLOITATION : il dit « donne-lui plus de missions ».
      // Sur FV-941-LZ, muet depuis 89 jours, ce conseil est faux — on ne peut rien lui confier,
      // on ne sait même pas où il est. On REQUALIFIE (le véhicule reste dans la liste, avec son
      // vrai ratio et toute sa heatmap) au lieu de le retirer : c'est un fait à traiter, pas
      // une donnée à cacher. Il redevient un candidat normal dès la première trame reçue.
      const dormant = isVehicleDormant(
        { trackerId: v.tracker?.id ?? null, lastSeenAt: v.tracker?.lastSeenAt ?? null },
        nowMs,
        // 7 j, EXPLICITEMENT. Écran de KPI : on COMPTE, on n'agit pas. Le seuil « arrêter d'AGIR »
        // (72 h) retirerait le badge « sous-utilisé » d'un véhicule simplement garé sur un pont de
        // trois jours — exactement le véhicule que cet écran existe pour faire remonter.
        DORMANT_STOP_COUNTING_MS,
      );

      for (let dow = 1; dow <= 7; dow++) {
        const denom = dowOccurrences.get(dow) ?? 0;
        for (const slot of slotOrder) {
          const active = a.cellDates.get(`${dow}:${slot}`)?.size ?? 0;
          const occupancy = denom > 0 ? Math.min(1, active / denom) : 0;
          cells.push({ dayOfWeek: dow, slot, occupancy: Math.round(occupancy * 100) / 100 });

          // Patterns « libres » : seulement pour un véhicule par ailleurs utilisé, hors nuit,
          // sur un créneau récurrent quasi vide → vraie opportunité de mutualisation.
          // Exclus pour un dormant : « libre tous les mardis matin » est la même promesse
          // inapplicable que le badge « sous-utilisé » (un véhicule devenu muet EN COURS de
          // fenêtre a bien des trajets, donc en produirait). La heatmap brute, elle, est
          // conservée telle quelle — c'est de l'historique.
          if (
            hasActivity &&
            !dormant &&
            slot !== 'night' &&
            denom >= FREE_PATTERN_MIN_OCCURRENCES &&
            occupancy <= FREE_PATTERN_MAX_OCCUPANCY &&
            freePatterns.length < MAX_FREE_PATTERNS
          ) {
            freePatterns.push(`${DOW_LABELS[dow]} ${SLOT_LABELS[slot]}`);
          }
        }
      }

      const utilizationRatio = Math.min(1, a.activeMs / windowMs);
      return {
        vehicleId: v.id,
        vehiclePlate: a.plate,
        tripCount: a.tripCount,
        activeHours: Math.round((a.activeMs / HOUR_MS) * 10) / 10,
        distanceKm: Math.round(a.distanceKm * 10) / 10,
        activeDays: a.activeDays.size,
        utilizationRatio: Math.round(utilizationRatio * 100) / 100,
        underutilized: !dormant && utilizationRatio < UNDERUTILIZED_RATIO,
        cells,
        freePatterns,
        dormant,
        silenceLabel: dormant ? formatSilenceLabel(v.tracker?.lastSeenAt ?? null, nowMs) : null,
      };
    });

    // Tri : les plus sous-utilisés d'abord (focus mutualisation), MAIS les dormants en fin de
    // liste. La tête de liste est la zone d'action : y laisser un véhicule injoignable (0 %
    // d'utilisation → premier du tri) reléguait sous lui les vrais candidats à la mutualisation.
    out.sort((x, y) => {
      if (x.dormant !== y.dormant) return x.dormant ? 1 : -1;
      return x.utilizationRatio - y.utilizationRatio;
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      periodDays,
      vehicles: out,
      // Requalifier sans dire combien reviendrait à faire baisser un chiffre en silence.
      dormantCount: out.filter((v) => v.dormant).length,
    };
  }
}
