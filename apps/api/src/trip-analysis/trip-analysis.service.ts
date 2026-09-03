import { Injectable, Logger, NotFoundException, Optional, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type { TripAnalysisDto } from '@vizyo/tracky-shared';
import { AiAvailabilityService } from '../ai/ai-availability.service';
import type { AuthUser } from '../auth/types/auth-user';
import { resolveTenantScope } from '../common/tenant-scope';
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
/**
 * Borne dure du lot d'ids acceptés par `listForTrips`. Aligne sur la page de trajets la
 * plus large de l'app (100 lignes) avec une marge : au-delà, c'est une liste inventée par
 * l'appelant, pas un écran.
 */
const MAX_TRIP_IDS_PER_BATCH = 200;

type TripRow = {
  id: string; fleetId: string; vehicleId: string; trackerId: string | null;
  startedAt: Date; endedAt: Date | null; distanceMeters: number | null;
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
    /** Optionnel pour les tests unitaires historiques ; absent = récits visibles. */
    @Optional() private readonly aiAvail?: AiAvailabilityService,
  ) {}

  /**
   * Le client voit-il les récits IA de cette société ?
   *
   * ── Décision du 2026-09-02 ──────────────────────────────────────────────────────────
   * L'agent sur poste rédige les récits de TOUTES les sociétés, option IA active ou non
   * (il ne coûte rien). Ce que le client a le droit de VOIR, lui, dépend de son option :
   * option coupée = récit, conseils et Trust Score masqués — la ligne d'analyse reste, ses
   * chiffres déterministes ne sont pas de l'IA. Le jour où l'option est activée, tout
   * l'historique déjà rédigé apparaît d'un coup, au lieu d'un compteur qui repart de zéro.
   *
   * Le super-admin voit tout : c'est lui qui vérifie que l'agent fait son travail.
   * Masquage SERVEUR, pas seulement UI : un écran qui cache un champ présent dans le JSON
   * ne protège rien.
   */
  private async narrativeVisible(user: AuthUser, fleetId: string): Promise<boolean> {
    if (user.role === UserRole.SUPER_ADMIN) return true;
    if (!this.aiAvail) return true;
    return this.aiAvail.isEnabledForFleet(fleetId);
  }

  /** Analyse (ou ré-analyse) un trajet et persiste le résultat. */
  async analyze(user: AuthUser, tripId: string): Promise<TripAnalysisDto> {
    const trip = (await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true, fleetId: true, vehicleId: true, trackerId: true, startedAt: true, endedAt: true, distanceMeters: true,
        vehicle: { select: { type: true, energy: true, fuelConsumptionL100km: true } },
      },
    })) as TripRow | null;
    if (!trip) throw new NotFoundException('Trajet introuvable');
    // Anti-IDOR : 404 (pas 403) pour ne pas révéler l'existence d'un trajet hors périmètre.
    if (!(await this.vehicleAccess.hasAccessToVehicle(user, trip.vehicleId))) throw new NotFoundException('Trajet introuvable');

    try {
      const result = await this.compute(trip);
      const row = await this.persist(trip, result);
      return this.toDto(row, this.maskFor(user), await this.narrativeVisible(user, trip.fleetId));
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
    return this.toDto(row, this.maskFor(user), await this.narrativeVisible(user, row.fleetId));
  }

  /**
   * Analyses de trajets DÉSIGNÉS, en un appel. Scopé (anti-IDOR) : une analyse hors
   * périmètre est omise du résultat, jamais renvoyée.
   *
   * ⚠️ Pourquoi cette route existe alors que `listForVehicle` existait déjà : l'écran
   * Rapports liste les trajets de PLUSIEURS véhicules dès qu'on filtre par société ou
   * par groupe. Faute de pouvoir charger les analyses correspondantes, il masquait
   * purement et simplement la colonne « Analyse » — récits IA compris — dans tous ces
   * cas. Et `listForVehicle` ne prend pas de période : il rend les 200 analyses les plus
   * récemment CALCULÉES du véhicule, qui ne recouvrent pas forcément les trajets listés.
   * Ici, on demande exactement les trajets affichés.
   */
  async listForTrips(user: AuthUser, tripIds: string[]): Promise<TripAnalysisDto[]> {
    const ids = [...new Set(tripIds.filter((t) => typeof t === 'string' && t.length > 0))];
    if (ids.length === 0) return [];

    const where: Prisma.TripAnalysisWhereInput = { tripId: { in: ids.slice(0, MAX_TRIP_IDS_PER_BATCH) } };
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    if (accessible !== 'ALL') {
      where.vehicleId = { in: accessible };
    } else {
      // 'ALL' = « aucune restriction PAR VÉHICULE », PAS « toute la base » : la borne
      // société reste indispensable (cf. vehicle-access.service, même piège d'IDOR).
      const scope = resolveTenantScope(user);
      if (scope.mode === 'FLEET') where.fleetId = scope.fleetId;
      else if (scope.mode === 'DENY') return [];
    }

    const rows = await this.prisma.tripAnalysis.findMany({ where });
    const mask = this.maskFor(user);
    // Un client n'a qu'une société ; un super-admin peut en voir plusieurs d'un coup.
    const visible = new Map<string, boolean>();
    for (const fleetId of new Set(rows.map((r) => r.fleetId))) {
      visible.set(fleetId, await this.narrativeVisible(user, fleetId));
    }
    return rows.map((r) => this.toDto(r, mask, visible.get(r.fleetId) ?? true));
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
    const showNarrative = rows.length > 0 ? await this.narrativeVisible(user, rows[0]!.fleetId) : true;
    return rows.map((r) => this.toDto(r, mask, showNarrative));
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
      /**
       * NE JAMAIS PERSISTER UNE ANALYSE VIDE SUR UN TRAJET QUI A ROULE.
       *
       * Zero position pour un trajet dont le compteur live affiche des centaines de metres n'a
       * que deux causes : la purge de retention est passee (fait definitif), ou les points ne
       * sont pas encore ecrits (buffer). Dans les deux cas, ecrire « distance 0, aucun arret »
       * fabrique une donnee FAUSSE et indiscernable d'un vrai trajet immobile — 60 analyses de
       * ce type retrouvees en base le 2026-08-21, toutes a la frontiere de purge du 18-19/06.
       * Mieux vaut refuser : l'appelant decide (le cron saute et recommencera, l'humain voit
       * un message honnete au lieu d'un zero invente).
       */
      if (positions.length === 0 && (trip.distanceMeters ?? 0) > 500) {
        throw new UnprocessableEntityException(
          'Analyse impossible : les positions de ce trajet ne sont plus disponibles (purge de retention probable). ' +
            'Produire une analyse vide reviendrait a inventer un trajet immobile.',
        );
      }
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
    narratedAt?: Date | null;
  }, maskProvider = false, showNarrative = true): TripAnalysisDto {
    // Option IA coupée pour la société : la couche IA (récit, conseils, Trust Score, moteur)
    // sort du DTO. Les chiffres déterministes restent — ce ne sont pas de l'IA.
    if (!showNarrative) {
      return { ...this.toDto({ ...row, provider: null, narrative: null, advice: null, trustScore: null, narratedAt: null }, maskProvider, true) };
    }
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
      narratedAt: row.narratedAt?.toISOString() ?? null,
    };
  }
}
