import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type { TripAnalysisDto } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { FuelStationService } from './fuel-station.service';
import { SpeedLimitService } from './speed-limit.service';
import { analyzeTrip, type RawPosition, type TripAnalysisResult } from './trip-analysis.preprocessor';

/** Vitesse (km/h) au-dessus de laquelle un point peut constituer un excès → candidat à la résolution OSM. */
const SPEEDING_CANDIDATE_KMH = 33; // couvre les zones 30 (avec marge)
/** Borne dure de positions lues par trajet (perf + coût). */
const MAX_POSITIONS = 5000;

type TripRow = {
  id: string; fleetId: string; vehicleId: string; trackerId: string | null;
  startedAt: Date; endedAt: Date | null;
  vehicle: { type: string; energy: string | null; fuelConsumptionL100km: number | null } | null;
};

/**
 * Traçabilité fine des trajets (Palier 2) — orchestration DÉTERMINISTE.
 * Charge les positions d'un trajet, résout les limites OSM des points rapides (best-effort), calcule
 * l'analyse (préprocesseur) et la PERSISTE (une par trajet). Scoping anti-IDOR : l'utilisateur doit
 * avoir accès au véhicule (sinon 404, pas 403). Aucun appel LLM ici (Palier 3).
 */
@Injectable()
export class TripAnalysisService {
  private readonly logger = new Logger(TripAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly speedLimits: SpeedLimitService,
    private readonly fuelStations: FuelStationService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /** Analyse (ou ré-analyse) un trajet et persiste le résultat. */
  async analyze(user: AuthUser, tripId: string): Promise<TripAnalysisDto> {
    const trip = (await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true, fleetId: true, vehicleId: true, trackerId: true, startedAt: true, endedAt: true,
        vehicle: { select: { type: true, energy: true, fuelConsumptionL100km: true } },
      },
    })) as TripRow | null;
    if (!trip) throw new NotFoundException('Trajet introuvable');
    // Anti-IDOR : 404 (pas 403) pour ne pas révéler l'existence d'un trajet hors périmètre.
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, trip.vehicleId))) throw new NotFoundException('Trajet introuvable');

    try {
      const result = await this.compute(trip);
      const row = await this.persist(trip, result);
      return this.toDto(row, this.maskFor(user));
    } catch (e) {
      // Échec du calcul déterministe (positions / préprocesseur / persistance) → centre d'alerte,
      // avec le contexte du trajet. On re-lève ensuite (le client reçoit bien l'erreur).
      void this.errorLogger.record(
        e instanceof Error ? e : new Error(String(e)),
        'trip-analysis',
        { tripId, vehicleId: trip.vehicleId, fleetId: trip.fleetId, stage: 'compute' },
      );
      throw e;
    }
  }

  /** Lit l'analyse persistée d'un trajet (null si jamais calculée). */
  async get(user: AuthUser, tripId: string): Promise<TripAnalysisDto | null> {
    const row = await this.prisma.tripAnalysis.findUnique({ where: { tripId } });
    if (!row) return null;
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, row.vehicleId))) throw new NotFoundException('Trajet introuvable');
    return this.toDto(row, this.maskFor(user));
  }

  /** Analyses récentes d'un véhicule (onglet Trajets / rapports). Scopé véhicule. */
  async listForVehicle(user: AuthUser, vehicleId: string, limit = 50): Promise<TripAnalysisDto[]> {
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, vehicleId))) throw new NotFoundException('Véhicule introuvable');
    const rows = await this.prisma.tripAnalysis.findMany({
      where: { vehicleId },
      orderBy: { computedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const mask = this.maskFor(user);
    return rows.map((r) => this.toDto(r, mask));
  }

  /**
   * Marque blanche : seul le super-admin (équipe interne) voit le vrai moteur (Claude/GPT/Mixte) ;
   * pour un fleet-admin ou en-dessous (client), on masque en « agent Tracky » (image de marque).
   */
  private maskFor(user: AuthUser): boolean {
    return user.role !== UserRole.SUPER_ADMIN;
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  private async compute(trip: TripRow): Promise<TripAnalysisResult> {
    let result: TripAnalysisResult;
    if (!trip.trackerId) {
      // Pas de tracker → pas de positions : analyse vide (mais persistable pour cohérence d'affichage).
      result = analyzeTrip([], this.vehicleFuel(trip));
    } else {
      const positions = await this.prisma.position.findMany({
        where: { trackerId: trip.trackerId, timestamp: { gte: trip.startedAt, lte: trip.endedAt ?? new Date() } },
        select: { lat: true, lng: true, speedKmh: true, heading: true, timestamp: true, valid: true, ignition: true, satellites: true },
        orderBy: { timestamp: 'asc' },
        take: MAX_POSITIONS,
      });
      const raw: RawPosition[] = positions;

      // Limites OSM uniquement pour les points RAPIDES (candidats d'excès) — borne le coût Overpass.
      const candidates = positions
        .filter((p) => p.valid !== false && p.speedKmh > SPEEDING_CANDIDATE_KMH && !(p.lat === 0 && p.lng === 0))
        .map((p) => ({ lat: p.lat, lng: p.lng }));
      let resolver;
      try {
        resolver = await this.speedLimits.buildResolver(candidates);
      } catch (e) {
        // buildResolver gère déjà l'indispo Overpass en interne (best-effort + trace) ; ce catch ne se
        // déclenche que pour un échec INATTENDU du résolveur → on trace et on continue sans limites.
        this.logger.warn(`limites OSM indisponibles : ${(e as Error)?.message ?? e}`);
        void this.errorLogger.record(
          e instanceof Error ? e : new Error(String(e)),
          'trip-analysis',
          { vehicleId: trip.vehicleId, fleetId: trip.fleetId, stage: 'speed-limit-resolver' },
        );
      }
      result = analyzeTrip(raw, this.vehicleFuel(trip), resolver);
    }

    // Passages en STATION-SERVICE (sur les arrêts détectés) — best-effort, jamais bloquant. Le service
    // persiste TripFuelStop + cache station + prix, et remonte les indispos API au centre d'alerte.
    try {
      const fuelStops = await this.fuelStations.detectAndPersist(
        { tripId: trip.id, fleetId: trip.fleetId, vehicleId: trip.vehicleId, energy: trip.vehicle?.energy ?? null },
        result.detail.stops,
      );
      if (fuelStops.length) result.detail.fuelStops = fuelStops;
    } catch (e) {
      this.logger.warn(`détection stations : ${(e as Error)?.message ?? e}`);
      void this.errorLogger.record(
        e instanceof Error ? e : new Error(String(e)),
        'fuel-station',
        { tripId: trip.id, vehicleId: trip.vehicleId, stage: 'detect' },
      );
    }
    return result;
  }

  private vehicleFuel(trip: TripRow) {
    return { type: trip.vehicle?.type ?? 'CAR', energy: trip.vehicle?.energy ?? null, fuelConsumptionL100km: trip.vehicle?.fuelConsumptionL100km ?? null };
  }

  private async persist(trip: TripRow, r: TripAnalysisResult) {
    const data = {
      fleetId: trip.fleetId,
      vehicleId: trip.vehicleId,
      distanceKm: r.distanceKm, durationSec: r.durationSec, movingSec: r.movingSec, avgSpeedKmh: r.avgSpeedKmh, maxSpeedKmh: r.maxSpeedKmh,
      stopCount: r.stopCount, idleSec: r.idleSec,
      gpsPoints: r.gpsPoints, gpsValidRatio: r.gpsValidRatio, gpsLostCount: r.gpsLostCount,
      speedingCount: r.speedingCount, speedingSec: r.speedingSec, maxOverKmh: r.maxOverKmh, limitsKnown: r.limitsKnown,
      harshAccel: r.harshAccel, harshBrake: r.harshBrake, ecoScore: r.ecoScore, fuelLiters: r.fuelLiters, co2Kg: r.co2Kg,
      detail: r.detail as unknown as Prisma.InputJsonValue,
    };
    return this.prisma.tripAnalysis.upsert({
      where: { tripId: trip.id },
      create: { tripId: trip.id, ...data },
      // La ré-analyse REMPLACE le déterministe mais N'EFFACE PAS le récit LLM (Palier 3) déjà calculé.
      update: data,
    });
  }

  private toDto(row: {
    tripId: string; vehicleId: string; computedAt: Date;
    distanceKm: number; durationSec: number; movingSec: number; avgSpeedKmh: number; maxSpeedKmh: number; stopCount: number; idleSec: number;
    gpsPoints: number; gpsValidRatio: number; gpsLostCount: number;
    speedingCount: number; speedingSec: number; maxOverKmh: number; limitsKnown: boolean;
    harshAccel: number; harshBrake: number; ecoScore: number; fuelLiters: number | null; co2Kg: number | null;
    detail: unknown; provider: string | null; narrative: string | null; advice: string | null; trustScore: number | null;
  }, maskProvider = false): TripAnalysisDto {
    // Marque blanche : le client ne voit qu'« agent Tracky » (jamais le moteur réel). On garde un
    // marqueur générique 'tracky' quand un récit existe (pour afficher « par l'agent Tracky »).
    const provider = maskProvider ? (row.provider ? 'tracky' : null) : row.provider;
    return {
      tripId: row.tripId, vehicleId: row.vehicleId, computedAt: row.computedAt.toISOString(),
      distanceKm: row.distanceKm, durationSec: row.durationSec, movingSec: row.movingSec, avgSpeedKmh: row.avgSpeedKmh, maxSpeedKmh: row.maxSpeedKmh,
      stopCount: row.stopCount, idleSec: row.idleSec,
      gpsPoints: row.gpsPoints, gpsValidRatio: row.gpsValidRatio, gpsLostCount: row.gpsLostCount,
      speedingCount: row.speedingCount, speedingSec: row.speedingSec, maxOverKmh: row.maxOverKmh, limitsKnown: row.limitsKnown,
      harshAccel: row.harshAccel, harshBrake: row.harshBrake, ecoScore: row.ecoScore, fuelLiters: row.fuelLiters, co2Kg: row.co2Kg,
      detail: row.detail as TripAnalysisDto['detail'],
      provider, narrative: row.narrative, advice: row.advice, trustScore: row.trustScore,
    };
  }
}
