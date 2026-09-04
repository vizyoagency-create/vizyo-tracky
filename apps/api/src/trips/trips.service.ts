import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, UserRole } from '@prisma/client';
import type { Trip } from '@prisma/client';
import type { TripCompletedEvent, TripRecomputeResultDto, TripStartedEvent } from '@vizyo/tracky-shared';
import { MAX_VITESSE_ANNONCEE_KMH, douglasPeucker, isPlausibleJump, isValidLatLng } from '@vizyo/tracky-shared';
import { parisDayKey, parisDayStart } from '../common/utils/datetime';
import { distanceMeters } from '../common/utils/haversine';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { ErrorLogger } from '../observability/error-logger.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { TripSortColumn } from './dto/list-trips.dto';
import { MapMatchingService } from './map-matching.service';
import { TripSegmenterService } from './trip-segmenter.service';
import {
  TRIP_MIN_DISTANCE_METERS,
  TRIP_SPEED_THRESHOLD_KMH,
  TRIP_STOP_TIMEOUT_MS,
  TRIP_MOVING_CONFIRM_MS,
} from './trip-segmenter.constants';

/**
 * Cap brut sur l'accumulation in-memory pendant un trip live.
 * 500 points >> 100 (V1.3) pour conserver la forme des longs trajets.
 * La polyline finale est ensuite simplifiee via Douglas-Peucker a la cloture.
 */
const TRIP_POLYPOINTS_CAP = 500;
const TRIP_POLYLINE_DP_TOLERANCE_M = 5;

/**
 * Plafond défensif sur la vitesse ANNONCÉE par le boîtier. Au-delà, la valeur est clampée.
 *
 * ── POURQUOI CE CHIFFRE A CHANGÉ (lot V7, 2026-09-04) ───────────────────────────────────
 *
 * Il valait 250, et il était le troisième plafond d'une même grandeur : 200 à l'ingestion
 * (`MAX_VITESSE_ANNONCEE_KMH`), 200 à l'analyse depuis le lot V1, 250 ici. Une vitesse de 210
 * était donc refusée à l'entrée, acceptée par le trajet, et ignorée par l'analyse — trois
 * écrans, trois vérités, pour un seul et même trajet. Mesuré le 4 septembre en production :
 * **81 trajets sur 14 364** (90 jours) portent une vitesse maximale au-dessus de 200, c'est-à-dire
 * une valeur que l'analyse du même trajet refuse d'affirmer.
 *
 * ⚠️ NE PAS CONFONDRE avec le seuil de `sanitizePositions` / `isPlausibleJump`, qui reste à 250
 * et doit y rester : celui-là ne mesure pas une vitesse annoncée mais une TÉLÉPORTATION —
 * distance parcourue divisée par le temps écoulé. Deux grandeurs différentes, deux seuils
 * différents ; les aligner « pour faire propre » confondrait un champ de trame avec une
 * trajectoire.
 */
const TRIP_MAX_PLAUSIBLE_SPEED_KMH = MAX_VITESSE_ANNONCEE_KMH;

/** Clamp d'une vitesse en km/h dans [0, TRIP_MAX_PLAUSIBLE_SPEED_KMH]. */
function sanitizeSpeed(kmh: number): number {
  if (!Number.isFinite(kmh)) return 0;
  if (kmh < 0) return 0;
  if (kmh > TRIP_MAX_PLAUSIBLE_SPEED_KMH) return TRIP_MAX_PLAUSIBLE_SPEED_KMH;
  return kmh;
}

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
  accessibleVehicleIds?: string[] | 'ALL';
}

interface OpenTripState {
  tripId: string;
  trackerId: string;
  vehicleId: string;
  fleetId: string;
  startedAt: Date;
  startLat: number;
  startLng: number;
  lastLat: number;
  lastLng: number;
  lastTimestamp: Date;
  dist: number;
  maxSpeed: number;
  speedSum: number;
  positionCount: number;
  polyPoints: Array<{ lat: number; lng: number }>;
  zeroSpeedSince: Date | null;
  vehiclePlate?: string;
}

interface MovingCandidate {
  firstMovingAt: Date;
  trackerId: string;
  vehicleId: string;
  fleetId: string;
  lat: number;
  lng: number;
  vehiclePlate?: string;
}

@Injectable()
export class TripsService implements OnModuleInit {
  private readonly logger = new Logger(TripsService.name);
  private readonly openTrips = new Map<string, OpenTripState>();
  private readonly movingCandidates = new Map<string, MovingCandidate>();
  private ready = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    private readonly segmenter: TripSegmenterService,
    private readonly mapMatching: MapMatchingService,
    @Optional() private readonly errorLogger?: ErrorLogger,
    @Optional() private readonly systemActivity?: SystemActivityService,
  ) {}

  async onModuleInit(): Promise<void> {
    const openDbTrips = await this.prisma.trip.findMany({
      where: { endedAt: null },
      include: { vehicle: true },
    });

    for (const trip of openDbTrips) {
      // #30 — un trip ouvert sans trackerId ne peut pas etre suivi en live (les
      // trames arrivent par IMEI -> trackerId). On l'ignore au lieu de le keyer
      // sur '' : sinon plusieurs trips sans tracker collisionnent sur la cle '' et
      // tous sauf un perdent leur etat live (orphelins jamais clotures).
      if (!trip.trackerId) {
        this.logger.warn(`Trip recovery: trip ${trip.id} sans trackerId ignore (non suivi en live)`);
        continue;
      }
      this.openTrips.set(trip.trackerId, {
        tripId: trip.id,
        trackerId: trip.trackerId,
        vehicleId: trip.vehicleId,
        fleetId: trip.fleetId ?? '',
        startedAt: trip.startedAt,
        startLat: trip.startLat,
        startLng: trip.startLng,
        lastLat: trip.endLat ?? trip.startLat,
        lastLng: trip.endLng ?? trip.startLng,
        lastTimestamp: trip.startedAt,
        dist: trip.distanceMeters,
        maxSpeed: trip.maxSpeed,
        speedSum: trip.avgSpeed * trip.positionCount,
        positionCount: trip.positionCount,
        polyPoints: [],
        zeroSpeedSince: null,
        vehiclePlate: (trip.vehicle as any)?.plate,
      });
    }

    this.ready = true;
    this.logger.log(`Trip recovery: ${this.openTrips.size}/${openDbTrips.length} open trips loaded`);
  }

  async processPosition(data: {
    trackerId: string;
    vehicleId: string;
    fleetId: string;
    lat: number;
    lng: number;
    speedKmh: number;
    timestamp: Date;
    ignition: boolean;
    vehiclePlate?: string;
  }): Promise<void> {
    if (!this.ready) return;

    // Garde-fou : positions hors-bornes / Null Island ne doivent jamais entrer
    // dans le pipeline trips (deja filtrees au niveau ingestion mais defense en
    // profondeur — d'autres callers peuvent appeler processPosition).
    if (!isValidLatLng(data.lat, data.lng)) {
      this.logger.warn(
        `processPosition: lat/lng invalides ignores (tracker=${data.trackerId} ` +
          `lat=${data.lat} lng=${data.lng})`,
      );
      return;
    }

    // Defense majeure (Sprint corruption-durations) : on ignore toute position
    // dont le timestamp n'est pas STRICTEMENT posterieur a la derniere position
    // consommee pour ce tracker. Sans ce garde-fou, les retransmissions tardives
    // (trackers en mode store-and-forward, batch ~25 min entrelace avec le live)
    // ecrasent `state.lastTimestamp`, ce qui produit `endedAt < startedAt` et des
    // `durationSeconds` negatifs persistes en DB. Distance live faussee aussi
    // (haversine entre points non adjacents temporellement).
    //
    // La position reste en table `Position` => recompute differe la consommera
    // proprement via le segmenter (qui pre-trie). On perd uniquement le live
    // pour cette position-la, ce qui est acceptable.
    const sanitizedSpeed = sanitizeSpeed(data.speedKmh);
    const state = this.openTrips.get(data.trackerId);
    if (state && data.timestamp.getTime() <= state.lastTimestamp.getTime()) {
      return;
    }

    if (!state) {
      if (data.ignition === false && sanitizedSpeed <= TRIP_SPEED_THRESHOLD_KMH) {
        this.movingCandidates.delete(data.trackerId);
        return;
      }

      if (sanitizedSpeed > TRIP_SPEED_THRESHOLD_KMH) {
        const candidate = this.movingCandidates.get(data.trackerId);
        if (!candidate) {
          this.movingCandidates.set(data.trackerId, {
            firstMovingAt: data.timestamp,
            trackerId: data.trackerId,
            vehicleId: data.vehicleId,
            fleetId: data.fleetId,
            lat: data.lat,
            lng: data.lng,
            vehiclePlate: data.vehiclePlate,
          });
        } else if (data.timestamp.getTime() - candidate.firstMovingAt.getTime() >= TRIP_MOVING_CONFIRM_MS) {
          await this.startTrip({ ...data, speedKmh: sanitizedSpeed });
          this.movingCandidates.delete(data.trackerId);
        }
      } else {
        this.movingCandidates.delete(data.trackerId);
      }
      return;
    }

    // Detection de saut aberrant (> 250 km/h implicite). Le test "timestamp
    // inverse" est deja absorbe par le garde-fou en tete de fonction.
    // Si saut detecte, on n'integre ni la distance ni le polypoint, mais on ne
    // ferme pas le trip pour autant (on attend la prochaine position propre).
    const plausible = isPlausibleJump(
      { lat: state.lastLat, lng: state.lastLng, timestamp: state.lastTimestamp },
      { lat: data.lat, lng: data.lng, timestamp: data.timestamp },
    );

    if (!plausible) {
      this.logger.warn(
        `Saut aberrant ignore pour tracker=${data.trackerId} ` +
          `(${state.lastLat},${state.lastLng}) -> (${data.lat},${data.lng})`,
      );
      // Conserver maxSpeed/speedSum/timestamp pour ne pas geler le trip.
      state.maxSpeed = Math.max(state.maxSpeed, sanitizedSpeed);
      state.speedSum += sanitizedSpeed;
      state.positionCount++;
      state.lastTimestamp = data.timestamp;
    } else {
      const d = distanceMeters(state.lastLat, state.lastLng, data.lat, data.lng);
      // Math.max(0, ...) defense en profondeur : haversine retourne deja >= 0.
      state.dist += Math.max(0, d);
      state.maxSpeed = Math.max(state.maxSpeed, sanitizedSpeed);
      state.speedSum += sanitizedSpeed;
      state.positionCount++;
      state.lastLat = data.lat;
      state.lastLng = data.lng;
      state.lastTimestamp = data.timestamp;
      if (state.polyPoints.length < TRIP_POLYPOINTS_CAP) {
        state.polyPoints.push({ lat: data.lat, lng: data.lng });
      }
    }

    if (data.ignition === false && sanitizedSpeed <= TRIP_SPEED_THRESHOLD_KMH) {
      await this.finalizeTrip(state, data.timestamp, 'ignition');
      return;
    }

    if (sanitizedSpeed === 0) {
      if (!state.zeroSpeedSince) {
        state.zeroSpeedSince = data.timestamp;
      } else if (data.timestamp.getTime() - state.zeroSpeedSince.getTime() >= TRIP_STOP_TIMEOUT_MS) {
        await this.finalizeTrip(state, state.zeroSpeedSince, 'speed');
      }
    } else {
      state.zeroSpeedSince = null;
    }
  }

  @Cron('*/60 * * * * *')
  async checkTimeouts(): Promise<void> {
    if (!this.ready) return;
    const now = Date.now();
    for (const [trackerId, state] of this.openTrips) {
      if (now - state.lastTimestamp.getTime() > TRIP_STOP_TIMEOUT_MS) {
        this.logger.warn(`Trip timeout for tracker ${trackerId}, closing`);
        // Garde par trip : une finalisation qui echoue (DB / map-matching / WS) ne
        // doit NI rejeter le cron (unhandled promise rejection) NI empecher la
        // fermeture des autres trips expires de ce tick. Le trip reste ouvert et
        // sera retente au prochain tick.
        try {
          await this.finalizeTrip(state, state.lastTimestamp, 'timeout');
        } catch (err) {
          this.logger.error(
            `finalizeTrip (timeout) a échoué pour tracker ${trackerId}: ${err instanceof Error ? err.message : err}`,
          );
          this.errorLogger?.recordBackground(
            err instanceof Error ? err : new Error(String(err)),
            'cron:trip-timeouts',
            { trackerId, tripId: state.tripId, vehicleId: state.vehicleId, fleetId: state.fleetId },
          );
        }
      }
    }
  }

  private async startTrip(data: {
    trackerId: string;
    vehicleId: string;
    fleetId: string;
    lat: number;
    lng: number;
    timestamp: Date;
    speedKmh: number;
    vehiclePlate?: string;
  }): Promise<void> {
    // #5 — claim SYNCHRONE du slot AVANT tout await, pour empecher l'ouverture de
    // deux trips concurrents pour le meme tracker (burst de positions store-and-
    // forward). processPosition n'a aucun await entre la lecture de l'etat et
    // l'appel a startTrip ; en posant l'etat ici avant `await create`, une autre
    // position du meme burst verra ce placeholder et ira dans la branche "trip en
    // cours" au lieu de redemarrer un second trip.
    if (this.openTrips.has(data.trackerId)) return;

    const initSpeed = sanitizeSpeed(data.speedKmh);
    const state: OpenTripState = {
      tripId: '', // patche apres la creation DB
      trackerId: data.trackerId,
      vehicleId: data.vehicleId,
      fleetId: data.fleetId,
      startedAt: data.timestamp,
      startLat: data.lat,
      startLng: data.lng,
      lastLat: data.lat,
      lastLng: data.lng,
      lastTimestamp: data.timestamp,
      dist: 0,
      maxSpeed: initSpeed,
      speedSum: initSpeed,
      positionCount: 1,
      polyPoints: [{ lat: data.lat, lng: data.lng }],
      zeroSpeedSince: null,
      vehiclePlate: data.vehiclePlate,
    };
    this.openTrips.set(data.trackerId, state);

    let trip;
    try {
      trip = await this.prisma.trip.create({
        data: {
          vehicleId: data.vehicleId,
          trackerId: data.trackerId,
          fleetId: data.fleetId,
          startedAt: data.timestamp,
          startLat: data.lat,
          startLng: data.lng,
        },
      });
    } catch (err) {
      // Echec creation -> libere le slot reserve (s'il est toujours le notre).
      if (this.openTrips.get(data.trackerId) === state) {
        this.openTrips.delete(data.trackerId);
      }
      throw err;
    }

    // Patche le tripId reel sur l'etat reserve (s'il est toujours le notre : une
    // cloture pendant la creation a pu le retirer entre-temps).
    if (this.openTrips.get(data.trackerId) === state) {
      state.tripId = trip.id;
    }

    const event: TripStartedEvent = {
      tripId: trip.id,
      vehicleId: data.vehicleId,
      trackerId: data.trackerId,
      fleetId: data.fleetId,
      startedAt: data.timestamp.toISOString(),
      startLat: data.lat,
      startLng: data.lng,
    };
    this.gateway.emitTripStarted(data.fleetId, event);
    this.logger.log(`Trip started: ${trip.id} for tracker ${data.trackerId}`);
  }

  private async finalizeTrip(state: OpenTripState, endTime: Date, source: string): Promise<void> {
    // #5 — trip encore en cours de creation (placeholder, tripId pas encore patche)
    // : ne pas le clore maintenant (l'update viserait id='' -> P2025). On le laisse
    // dans openTrips ; il sera clos par une position suivante / le cron une fois le
    // tripId pose.
    if (!state.tripId) return;
    // Anti-race / idempotence (Sprint 0.1) : on "claim" le trip en retirant l'état
    // AVANT tout await. Un burst de positions (store-and-forward rejoué à la
    // reconnexion d'un boîtier qui flappe) ou le cron checkTimeouts pouvait
    // ré-entrer finalizeTrip sur le MÊME state -> double update, ou update après
    // qu'un autre appel a supprimé le trip court -> P2025 "record not found"
    // (vu en prod sur EP 047 TY). Si l'état n'est plus le nôtre, un autre appel
    // l'a déjà clôturé : on sort.
    if (this.openTrips.get(state.trackerId) !== state) return;
    this.openTrips.delete(state.trackerId);

    // Clamp defensif (V1.4 Sprint 4) : haversine est toujours >= 0, mais une
    // valeur negative ne doit jamais etre persistee. Defense en profondeur.
    const safeDist = Math.max(0, state.dist);

    if (safeDist < TRIP_MIN_DISTANCE_METERS) {
      await this.prisma.trip.delete({ where: { id: state.tripId } }).catch(
        (e) => this.logger.warn(`Trip delete failed: ${state.tripId}`, e),
      );
      this.openTrips.delete(state.trackerId);
      return;
    }

    // Garde-fou anti `durationSeconds` negatif : si le caller passe un endTime
    // anterieur au start (ne devrait plus arriver depuis Fix A, mais belt-and-
    // suspenders), on retombe sur le dernier timestamp sain ou le start.
    // Garantie : `safeEnd >= state.startedAt` toujours.
    const startMs = state.startedAt.getTime();
    const lastMs = state.lastTimestamp.getTime();
    const endMs = endTime.getTime();
    const safeEndMs = endMs >= startMs
      ? endMs
      : (lastMs >= startMs ? lastMs : startMs);
    const safeEnd = safeEndMs === endMs ? endTime : new Date(safeEndMs);

    if (safeEndMs !== endMs) {
      this.logger.warn(
        `finalizeTrip: endTime anterieur au start clampe ` +
          `(trip=${state.tripId} start=${state.startedAt.toISOString()} ` +
          `endRequest=${endTime.toISOString()} -> ${safeEnd.toISOString()})`,
      );
    }

    const dur = Math.max(0, Math.round((safeEndMs - startMs) / 1000));
    const avg = state.positionCount > 0 ? Math.round((state.speedSum / state.positionCount) * 100) / 100 : 0;

    // Simplification Douglas-Peucker : reduit le poids stocke en preservant la
    // forme. Pour un trajet urbain typique, divise les points par 5 a 10.
    const simplifiedPoly = douglasPeucker(state.polyPoints, TRIP_POLYLINE_DP_TOLERANCE_M);

    // Phase 2 — Snape le conducteur courant du vehicule (Vehicle.currentDriverId)
    // sur le trip (Trip.driverId, driverSource='AUTO'). Si pas de driver assigne
    // au vehicule, on laisse driverId=null. On ne touche PAS un driver deja
    // assigne (cas: recompute via assignToTrip avant finalize hypothetique).
    let autoDriverId: string | null = null;
    try {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: state.vehicleId },
        select: { currentDriverId: true },
      });
      if (vehicle?.currentDriverId) autoDriverId = vehicle.currentDriverId;
    } catch (err) {
      this.logger.warn(`Driver snap failed for trip ${state.tripId}: ${err}`);
    }

    // Plafond defensif sur la vitesse max (cap firmware glitch). Borne haute
     // = TRIP_MAX_PLAUSIBLE_SPEED_KMH, alignée sur le plafond d'INGESTION (lot V7).
     const safeMaxSpeed = Math.min(
       TRIP_MAX_PLAUSIBLE_SPEED_KMH,
       Math.max(0, state.maxSpeed),
     );
     const safeAvgSpeed = Math.min(
       TRIP_MAX_PLAUSIBLE_SPEED_KMH,
       Math.max(0, avg),
     );

    try {
      await this.prisma.trip.update({
        where: { id: state.tripId },
        data: {
          endedAt: safeEnd,
          endLat: state.lastLat,
          endLng: state.lastLng,
          durationSeconds: dur,
          distanceMeters: Math.round(safeDist),
          distanceKm: Math.round(safeDist / 10) / 100,
          maxSpeed: Math.round(safeMaxSpeed * 100) / 100,
          avgSpeed: safeAvgSpeed,
          positionCount: state.positionCount,
          segmentationSource: source,
          polyline: JSON.stringify(simplifiedPoly),
          ...(autoDriverId
            ? { driverId: autoDriverId, driverSource: 'AUTO' }
            : {}),
        },
      });
    } catch (e) {
      // Belt-and-suspenders : le trip a pu être supprimé entre-temps par une
      // autre voie (recompute deleteMany, suppression manuelle). On ne remonte
      // pas une erreur applicative pour une course bénigne.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        this.logger.warn(
          `finalizeTrip: trip ${state.tripId} introuvable (déjà supprimé/clôturé), skip`,
        );
        return;
      }
      throw e;
    }

    // Sprint G.3 — map-matching OSRM async (non-bloquant pour la cloture du trip).
    this.runMapMatchingAsync(state.tripId, simplifiedPoly);

    const event: TripCompletedEvent = {
      tripId: state.tripId,
      vehicleId: state.vehicleId,
      trackerId: state.trackerId,
      fleetId: state.fleetId,
      startedAt: state.startedAt.toISOString(),
      endedAt: safeEnd.toISOString(),
      durationSeconds: dur,
      distanceMeters: Math.round(safeDist),
      maxSpeed: Math.round(safeMaxSpeed * 100) / 100,
      avgSpeed: safeAvgSpeed,
    };
    this.gateway.emitTripCompleted(state.fleetId, event);
    this.openTrips.delete(state.trackerId);
    this.logger.log(`Trip completed: ${state.tripId} (${source}, ${Math.round(safeDist)}m, ${dur}s)`);
  }

  /**
   * Select Prisma minimal pour inclure les infos de l'auteur de la note dans
   * les responses Trip. Reste aligne avec `TripNoteAuthorDto` cote shared.
   */
  private static readonly NOTES_AUTHOR_INCLUDE = {
    notesUpdatedBy: {
      select: { id: true, firstName: true, lastName: true, email: true },
    },
    /** Phase 2 — driver snape sur le trajet (cf. DriverSummaryDto). */
    driver: {
      select: { id: true, firstName: true, lastName: true, color: true, isActive: true },
    },
  } as const;

  /**
   * Colonnes scalaires d'un trajet en charge ALLÉGÉE : tout sauf les deux polylignes.
   * Liste explicite plutôt qu'une exclusion : Prisma n'a pas d'« omit » stable en 6.x et une
   * colonne ajoutée au modèle doit être ajoutée ici EXPRÈS (le contrat léger est un contrat).
   */
  private static readonly LIGHT_TRIP_SELECT = {
    id: true, vehicleId: true, trackerId: true, fleetId: true,
    startedAt: true, endedAt: true, durationSeconds: true,
    startLat: true, startLng: true, endLat: true, endLng: true,
    distanceKm: true, distanceMeters: true, maxSpeed: true, avgSpeed: true,
    positionCount: true, segmentationSource: true, missionId: true,
    notes: true, notesUpdatedAt: true, notesUpdatedById: true,
    driverId: true, driverSource: true, createdAt: true,
  } as const;

  /**
   * Résout le filtre `where.vehicleId` depuis un véhicule unique OU une liste
   * (filtre groupe), borné au périmètre véhicules de l'appelant.
   *
   * 🔒 Sprint 5 — délègue à `resolveReportVehicleScope` (helper partagé avec les
   * rapports/exports) pour une règle EXACTE et cohérente :
   *   - périmètre 'ALL' (admins) : pas de borne (ou la demande explicite telle
   *     quelle, la borne `fleetId` couvrant l'appartenance flotte) ;
   *   - périmètre restreint : borne par défaut au périmètre permis, ET **rejet
   *     (ForbiddenException)** de toute demande explicite hors périmètre — plus
   *     strict que l'ancien retour silencieux `['__none__']`.
   *
   * Retourne `undefined` quand aucune borne `vehicleId` n'est nécessaire.
   */
  private resolveVehicleScope(
    rb: RequestedBy,
    vehicleId?: string,
    vehicleIds?: string,
  ): Prisma.TripWhereInput['vehicleId'] {
    const requested = (vehicleIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const wanted = requested.length ? requested : vehicleId ? [vehicleId] : undefined;
    const scope = resolveReportVehicleScope(rb.accessibleVehicleIds ?? 'ALL', wanted);
    if (scope === 'ALL') return undefined;
    return scope.length === 1 ? scope[0] : { in: scope };
  }

  /**
   * Ordre de tri d'une page de trajets.
   *
   * ⚠️ Le `id` en second critère n'est PAS cosmétique : `startedAt` et `maxSpeed` ne
   * sont pas uniques (deux trajets peuvent démarrer à la même seconde, et des dizaines
   * plafonnent à la même vitesse). Sans départage unique, l'ordre de deux lignes ex
   * aequo n'est pas garanti d'une requête à l'autre — et la pagination par curseur, qui
   * reprend « après cette ligne », sauterait ou répéterait des trajets à chaque page.
   * Même direction que le critère principal pour que la comparaison reste un simple
   * ordre lexicographique du couple (colonne, id).
   */
  private static tripOrderBy(
    sortBy: TripSortColumn | undefined,
    sortDir: 'asc' | 'desc' | undefined,
  ): Prisma.TripOrderByWithRelationInput[] {
    const col: TripSortColumn = sortBy ?? 'startedAt';
    const dir: Prisma.SortOrder = sortDir === 'asc' ? 'asc' : 'desc';
    return [{ [col]: dir } as Prisma.TripOrderByWithRelationInput, { id: dir }];
  }

  async list(
    requestedBy: RequestedBy,
    filters: {
      vehicleId?: string;
      vehicleIds?: string;
      from?: string;
      to?: string;
      limit?: string;
      cursor?: string;
      fleetId?: string;
      sortBy?: TripSortColumn;
      sortDir?: 'asc' | 'desc';
      light?: string;
    },
  ): Promise<{ items: Trip[]; nextCursor: string | null }> {
    // Mode vie privée (RGPD) : masque les trajets d'un véhicule actuellement en mode privé.
    const where: Prisma.TripWhereInput = { endedAt: { not: null }, NOT: { vehicle: { privacyModeEnabled: true } } };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      // #31 — fail-closed : un non-super sans fleetId ne voit AUCUN trajet (sinon
      // where.fleetId=null exposerait les trajets a fleetId null). Idem findOne().
      if (!requestedBy.fleetId) return { items: [], nextCursor: null };
      where.fleetId = requestedBy.fleetId;
    } else if (filters.fleetId) {
      // Filtre société GLOBAL (sélecteur super-admin) : scope le rapport à une flotte.
      // Anti-IDOR : le super-admin a accès à toutes les flottes.
      where.fleetId = filters.fleetId;
    }
    // Périmètre véhicule : vehicleId unique OU vehicleIds (filtre groupe), borné aux accès.
    const vScope = this.resolveVehicleScope(requestedBy, filters.vehicleId, filters.vehicleIds);
    if (vScope !== undefined) where.vehicleId = vScope;
    if (filters.from || filters.to) {
      where.startedAt = {};
      // Jours civils Europe/Paris — même lecture que les agrégats (cf. buildPeriodWhere).
      if (filters.from) (where.startedAt as any).gte = parisDayStart(filters.from);
      // Borne haute EXCLUSIVE : l'écran envoie le lendemain comme `to`. Avec `lte`, un trajet
      // parti à minuit pile appartenait à DEUX périodes voisines et était compté deux fois.
      if (filters.to) (where.startedAt as any).lt = parisDayStart(filters.to);
    }

    const limit = Math.min(filters.limit ? parseInt(filters.limit, 10) : 20, 100);
    const pagination = {
      orderBy: TripsService.tripOrderBy(filters.sortBy, filters.sortDir),
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    };
    const light = filters.light === '1' || filters.light === 'true';
    const items = light
      // Charge allégée (cf. `ListTripsDto.light`) : les polylignes et la fiche véhicule
      // complète restent en base. `select` et `include` s'excluent chez Prisma, d'où les
      // deux branches ; le résultat est typé `Trip` par commodité de contrat — les champs
      // omis sont simplement ABSENTS du JSON, jamais renvoyés à null (un `null` dirait
      // « ce trajet n'a pas de tracé », ce qui est faux).
      ? ((await this.prisma.trip.findMany({
          where,
          select: {
            ...TripsService.LIGHT_TRIP_SELECT,
            vehicle: { select: { id: true, fleetId: true, plate: true, type: true, brand: true, model: true } },
            ...TripsService.NOTES_AUTHOR_INCLUDE,
          },
          ...pagination,
        })) as unknown as Trip[])
      : await this.prisma.trip.findMany({
          where,
          include: { vehicle: true, ...TripsService.NOTES_AUTHOR_INCLUDE },
          ...pagination,
        });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1]!.id : null };
  }

  async findOne(id: string, requestedBy: RequestedBy): Promise<Trip> {
    // Filtre tenant integre au where (404 si autre flotte, pas 403 -> pas d'enum).
    const where: Prisma.TripWhereInput = { id };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Trajet introuvable');
      where.fleetId = requestedBy.fleetId;
    }
    const trip = await this.prisma.trip.findFirst({
      where,
      include: { vehicle: true, ...TripsService.NOTES_AUTHOR_INCLUDE },
    });
    if (!trip) throw new NotFoundException('Trajet introuvable');

    // Mode vie privée (RGPD) : un trajet d'un véhicule en mode privé est masqué (404, pas d'énum).
    if (trip.vehicle?.privacyModeEnabled) throw new NotFoundException('Trajet introuvable');

    // Acces granulaire : si l'utilisateur a un access scope (groupes/vehicules),
    // verifier que le vehicule du trajet est bien dans son scope.
    if (
      requestedBy.accessibleVehicleIds &&
      requestedBy.accessibleVehicleIds !== 'ALL' &&
      !requestedBy.accessibleVehicleIds.includes(trip.vehicleId)
    ) {
      throw new NotFoundException('Trajet introuvable');
    }
    return trip;
  }

  /**
   * Met a jour la note libre du trajet. Verifie acces fleet + acces vehicule.
   *
   * Comportement :
   *   - notes null/empty/whitespace-only => efface la note (set null) et
   *     reset auteur/date pour ne pas attribuer a tort une note vide.
   *   - notes non vide => trim + persist, set auteur = requestedBy, set date = now.
   */
  async updateNote(
    id: string,
    requestedBy: RequestedBy,
    notes: string | null,
  ): Promise<Trip> {
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      select: { id: true, fleetId: true, vehicleId: true },
    });
    if (!trip) throw new NotFoundException('Trajet introuvable');

    if (requestedBy.role !== UserRole.SUPER_ADMIN && trip.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Accès refusé');
    }
    // Acces granulaire : si l'utilisateur a un access scope (groupes/vehicules),
    // il faut que le vehicule du trajet soit dans son scope.
    if (
      requestedBy.accessibleVehicleIds &&
      requestedBy.accessibleVehicleIds !== 'ALL' &&
      !requestedBy.accessibleVehicleIds.includes(trip.vehicleId)
    ) {
      throw new ForbiddenException('Accès refusé au véhicule de ce trajet');
    }

    const trimmed = notes?.trim() ?? '';
    const isClear = trimmed.length === 0;

    return this.prisma.trip.update({
      where: { id },
      data: isClear
        ? { notes: null, notesUpdatedAt: null, notesUpdatedById: null }
        : {
            notes: trimmed,
            notesUpdatedAt: new Date(),
            notesUpdatedById: requestedBy.userId,
          },
      include: { vehicle: true, ...TripsService.NOTES_AUTHOR_INCLUDE },
    });
  }

  /**
   * Filtre commun à TOUS les agrégats de période (résumé journalier, graphiques).
   *
   * ⚠️ EXTRAIT PLUTÔT QUE RECOPIÉ, et c'est le point important : ce bloc porte le
   * cloisonnement (flotte, périmètre véhicule, mode vie privée). Deux copies auraient
   * divergé au premier changement de règle, et l'agrégat le moins souvent relu serait
   * devenu celui qui fuit. Un seul endroit, donc une seule règle.
   *
   * Rend `null` quand l'appelant ne peut rien voir (fail-closed) : l'appelant doit alors
   * répondre vide, JAMAIS interroger la base sans filtre de flotte.
   */
  private buildPeriodWhere(
    requestedBy: RequestedBy,
    filters: { vehicleId?: string; vehicleIds?: string; from?: string; to?: string; fleetId?: string },
  ): Prisma.TripWhereInput | null {
    // Mode vie privée (RGPD) : exclut les véhicules en mode privé des agrégats.
    const where: Prisma.TripWhereInput = { endedAt: { not: null }, NOT: { vehicle: { privacyModeEnabled: true } } };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) return null; // #31 — fail-closed (cf. list / findOne)
      where.fleetId = requestedBy.fleetId;
    } else if (filters.fleetId) {
      where.fleetId = filters.fleetId; // filtre société global (super-admin)
    }
    // Périmètre véhicule (unique ou groupe), borné aux accès — cf. list().
    const vScope = this.resolveVehicleScope(requestedBy, filters.vehicleId, filters.vehicleIds);
    if (vScope !== undefined) where.vehicleId = vScope;
    // Jours civils Europe/Paris (cf. `parisDayStart`) : « 2026-08-03 » = minuit à Paris,
    // pas minuit UTC. Un ISO complet (avec heure) reste lu tel quel.
    if (filters.from) where.startedAt = { ...(where.startedAt as any ?? {}), gte: parisDayStart(filters.from) };
    // Borne haute EXCLUSIVE, comme dans `list()` — sinon le trajet de minuit pile est compté
    // dans la période qui finit ET dans celle qui commence.
    if (filters.to) where.startedAt = { ...(where.startedAt as any ?? {}), lt: parisDayStart(filters.to) };
    return where;
  }

  async dailySummary(
    requestedBy: RequestedBy,
    filters: { vehicleId?: string; vehicleIds?: string; from?: string; to?: string; fleetId?: string },
  ): Promise<Array<{ date: string; tripCount: number; totalDistanceMeters: number; totalDurationSeconds: number; maxSpeed: number }>> {
    const where = this.buildPeriodWhere(requestedBy, filters);
    if (where === null) return [];

    const trips = await this.prisma.trip.findMany({ where, orderBy: { startedAt: 'asc' } });

    const byDate = new Map<string, { count: number; dist: number; dur: number; maxSpd: number }>();
    for (const t of trips) {
      // Jour civil de PARIS, pas jour UTC : 5 % des trajets changeaient de jour entre le
      // tableau (heure locale) et ce résumé (cf. `parisDayKey`).
      const date = parisDayKey(t.startedAt);
      const entry = byDate.get(date) ?? { count: 0, dist: 0, dur: 0, maxSpd: 0 };
      entry.count++;
      // Defense en profondeur : ignore les valeurs negatives heritees (legacy
      // pre-fix). La CHECK constraint et le clamp dans finalizeTrip garantissent
      // qu'aucune nouvelle valeur ne sera negative, mais on protege l'agregation
      // pour les bases qui n'ont pas encore migre / nettoye.
      entry.dist += Math.max(0, t.distanceMeters);
      entry.dur += Math.max(0, t.durationSeconds);
      // maxSpd : ignorer les valeurs aberrantes (> seuil plafond + clamp neg).
      const spd = Math.max(0, Math.min(TRIP_MAX_PLAUSIBLE_SPEED_KMH, t.maxSpeed));
      entry.maxSpd = Math.max(entry.maxSpd, spd);
      byDate.set(date, entry);
    }

    return Array.from(byDate.entries()).map(([date, e]) => ({
      date,
      tripCount: e.count,
      totalDistanceMeters: Math.round(e.dist),
      totalDurationSeconds: e.dur,
      maxSpeed: Math.round(e.maxSpd * 100) / 100,
    }));
  }

  /**
   * Données des graphiques « Vitesses max » et « Fréquentation », sur la période ENTIÈRE.
   *
   * ══ Pourquoi cet agrégat existe (constat du 2026-08-03) ═══════════════════════════════
   *
   * Ces deux graphiques se calculaient côté client depuis la liste AFFICHÉE des trajets,
   * bornée à 100 par la requête. Sur 30 jours et 2 738 trajets, la fréquentation ne
   * couvrait donc qu'environ une journée : elle affichait ZÉRO trajet le mardi alors que
   * le résumé journalier, sur le même écran, en comptait 132 le mardi 15 juillet.
   *
   * Deux chiffres contradictoires dans la même page — et le plus faux avait l'air d'un
   * fait, puisqu'il était dessiné.
   *
   * ⚠️ FUSEAU HORAIRE. La heatmap répond à « à quelle heure roule-t-on ? » : la question
   * n'a de sens qu'en heure LOCALE. Le calcul client utilisait l'heure du navigateur
   * (Paris) ; le serveur, lui, tourne en UTC. Extraire l'heure sans préciser le fuseau
   * décalerait toute la grille d'une à deux heures selon la saison — un décalage
   * parfaitement invisible, puisque le graphique resterait plausible.
   */
  async periodCharts(
    requestedBy: RequestedBy,
    filters: { vehicleId?: string; vehicleIds?: string; from?: string; to?: string; fleetId?: string },
  ): Promise<{ speeds: number[]; heatmap: number[][] }> {
    const empty = { speeds: [], heatmap: TripsService.emptyHeatmap() };
    const where = this.buildPeriodWhere(requestedBy, filters);
    if (where === null) return empty;

    // Seules deux colonnes sont lues : sur des dizaines de milliers de trajets, charger
    // les lignes entières coûterait cher pour rien.
    const trips = await this.prisma.trip.findMany({
      where,
      select: { startedAt: true, maxSpeed: true },
      orderBy: { startedAt: 'asc' },
    });

    const heatmap = TripsService.emptyHeatmap();
    const speeds: number[] = [];
    for (const t of trips) {
      speeds.push(Math.max(0, Math.min(TRIP_MAX_PLAUSIBLE_SPEED_KMH, t.maxSpeed)));
      const { day, hour } = TripsService.parisDayHour(t.startedAt);
      heatmap[day]![hour]! += 1;
    }
    return { speeds, heatmap };
  }

  /** Grille 7×24 vide — lundi = 0 (convention FR/ISO), comme côté écran. */
  private static emptyHeatmap(): number[][] {
    return Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  }

  /**
   * Jour de semaine (lundi = 0) et heure, en **Europe/Paris**.
   *
   * ⚠️ Le fuseau est explicite et NON déduit de l'environnement : le serveur tourne en
   * UTC, et `getDay()` / `getHours()` y renverraient l'heure UTC. En été, un trajet parti
   * à 01h00 à Paris serait compté à 23h00 la veille — donc le mauvais jour ET la mauvaise
   * heure, sans que rien ne le signale.
   */
  private static parisDayHour(d: Date): { day: number; hour: number } {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Paris',
      weekday: 'short',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '0';
    const ORDRE = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const day = Math.max(0, ORDRE.indexOf(wd));
    // `hour12: false` peut rendre « 24 » à minuit selon la plateforme : on le ramène à 0
    // plutôt que d'écrire hors de la grille (ce qui lèverait, ou pire, serait ignoré).
    const hour = Number.parseInt(hourRaw, 10) % 24;
    return { day, hour: Number.isFinite(hour) ? hour : 0 };
  }

  async recompute(
    requestedBy: RequestedBy,
    dto: { vehicleId: string; from: string; to: string },
  ): Promise<TripRecomputeResultDto> {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: dto.vehicleId },
      include: { tracker: true },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');
    if (requestedBy.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== requestedBy.fleetId) {
      throw new ForbiddenException('Accès refusé');
    }
    if (!vehicle.tracker) throw new BadRequestException('Véhicule sans tracker');

    const fromDate = new Date(dto.from);
    const toDate = new Date(dto.to) > tenMinAgo ? tenMinAgo : new Date(dto.to);

    // #16 — ne lacher l'etat live QUE si le trip ouvert correspondant tombe dans
    // la fenetre recalculee (il sera alors supprime par le deleteMany ci-dessous
    // puis recree). S'il a demarre HORS fenetre, le supprimer orphelinerait un trip
    // ouvert (etat live perdu ET non supprime en DB => jamais cloture).
    const liveState = this.openTrips.get(vehicle.tracker.id);
    if (
      liveState &&
      liveState.startedAt.getTime() >= fromDate.getTime() &&
      liveState.startedAt.getTime() <= toDate.getTime()
    ) {
      this.openTrips.delete(vehicle.tracker.id);
    }

    /**
     * ⚠️ SUPPRIMER LES TRAJETS SANS LEURS ANALYSES LES LAISSAIT ORPHELINES.
     *
     * `TripAnalysis.tripId` n'a PAS de relation en base (Uuid nu, cf. schema) : aucune cascade
     * ne s'applique. Le recalcul detruisait donc les trajets en abandonnant derriere lui des
     * analyses pointant vers du vide — invisibles dans l'application, mais bien presentes.
     *
     * Releve du 2026-08-21 : 2 704 analyses orphelines accumulees depuis le 8 juillet, dont
     * 493 PORTAIENT UN RECIT IA. Autant de jetons depenses pour un texte que plus personne ne
     * peut lire. Elles faussaient aussi tous les comptages — « analyses faites » incluait des
     * lignes sans trajet.
     *
     * On nettoie donc comme le fait deja la purge de retention (`trips-retention.service.ts`) :
     * les dependances d'abord, le trajet ensuite. Une analyse decrit un decoupage precis ; apres
     * re-segmentation ce decoupage n'existe plus, la conserver n'aurait aucun sens.
     */
    /**
     * ⚠️ LE TRAVAIL SAISI À LA MAIN NE DOIT PAS PARTIR AVEC LA GÉOMÉTRIE.
     *
     * Le recalcul détruit des trajets et en recrée d'autres à partir des positions. Jusqu'ici,
     * il emportait avec eux les NOTES rédigées par un exploitant, le CONDUCTEUR affecté et la
     * MISSION rattachée — et le dialogue de confirmation n'en disait pas un mot : il annonçait
     * la perte des analyses et des récits IA, produits par une machine, en taisant celle du
     * seul contenu qu'un humain avait écrit.
     *
     * On relève donc ce qui porte une trace humaine AVANT de supprimer, pour le rattacher
     * ensuite au nouveau trajet qui recouvre le mieux la même période.
     */
    const aSupprimer = await this.prisma.trip.findMany({
      where: { vehicleId: dto.vehicleId, startedAt: { gte: fromDate, lte: toDate } },
      select: {
        id: true, startedAt: true, endedAt: true,
        notes: true, notesUpdatedAt: true, notesUpdatedById: true,
        driverId: true, driverSource: true, missionId: true,
      },
    });
    const aReprendre = aSupprimer.filter((t) => t.notes != null || t.driverId != null || t.missionId != null);
    const idsSupprimes = aSupprimer.map((t) => t.id);
    if (idsSupprimes.length > 0) {
      await this.prisma.tripFuelStop.deleteMany({ where: { tripId: { in: idsSupprimes } } });
      await this.prisma.tripAnalysis.deleteMany({ where: { tripId: { in: idsSupprimes } } });
    }

    const { count: deleted } = await this.prisma.trip.deleteMany({
      where: {
        vehicleId: dto.vehicleId,
        startedAt: { gte: fromDate, lte: toDate },
      },
    });

    const positions = await this.prisma.position.findMany({
      where: {
        trackerId: vehicle.tracker.id,
        timestamp: { gte: fromDate, lte: toDate },
      },
      orderBy: { timestamp: 'asc' },
    });

    /**
     * ⚠️ MÊME POPULATION DE POINTS QUE L'ANALYSE (lot V7). Le recalcul prenait toutes les
     * positions ; l'analyse écarte celles dont le fix GPS est invalide (`valid: false`). Deux
     * populations, donc deux vitesses maximales possibles pour un même trajet, sans que rien
     * ne le dise.
     *
     * ⚠️ Mesuré le 4 septembre : ZÉRO position invalide sur 716 240 en trente jours — la porte
     * d'ingestion les refuse déjà. Cet alignement ne change donc rien aujourd'hui, et c'est
     * exactement pourquoi il vaut la peine d'être posé maintenant : le jour où une trame
     * invalide passera, les deux chaînes la traiteront pareil.
     */
    const drafts = this.segmenter.segmentPositions(
      positions.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        speedKmh: p.speedKmh,
        timestamp: p.timestamp,
        valid: p.valid,
        ignition: undefined,
      })),
    );

    let created = 0;
    /** Anciens trajets déjà rattachés — un jeu de notes ne peut vivre que sur un seul trajet. */
    const dejaRepris = new Set<string>();
    let notesReprises = 0;
    let conducteursRepris = 0;
    for (const draft of drafts) {
      const safeDist = Math.max(0, draft.distanceMeters);
      // Defense en profondeur : le segmenter pre-trie donc draft.durationSeconds
      // est >= 0 par construction, mais on clamp pour rester aligne avec la
      // CHECK constraint DB et le contrat finalizeTrip.
      const safeDur = Math.max(0, draft.durationSeconds);
      const safeMaxSpeed = Math.min(
        TRIP_MAX_PLAUSIBLE_SPEED_KMH,
        Math.max(0, draft.maxSpeed),
      );
      const safeAvgSpeed = Math.min(
        TRIP_MAX_PLAUSIBLE_SPEED_KMH,
        Math.max(0, draft.avgSpeed),
      );
      // Garantie chronologique : si le segmenter a produit endedAt < startedAt
      // (ne devrait jamais arriver vu le pre-tri, mais defense en profondeur),
      // on force endedAt = startedAt + safeDur.
      const safeEndedAt = draft.endedAt.getTime() >= draft.startedAt.getTime()
        ? draft.endedAt
        : new Date(draft.startedAt.getTime() + safeDur * 1000);
      const simplifiedPoly = douglasPeucker(draft.positions, TRIP_POLYLINE_DP_TOLERANCE_M);
      /**
       * À quel ANCIEN trajet ce nouveau correspond-il ? Celui dont la période se recouvre le
       * plus. Le recouvrement est la seule mesure fiable : le redécoupage peut fondre deux
       * trajets en un ou couper un trajet en deux, et les identifiants ne survivent pas.
       */
      const ancien = this.ancienLeMieuxRecouvert(draft.startedAt, safeEndedAt, aReprendre, dejaRepris);
      if (ancien) dejaRepris.add(ancien.id);
      if (ancien?.notes != null) notesReprises++;
      if (ancien?.driverId != null) conducteursRepris++;

      const newTrip = await this.prisma.trip.create({
        data: {
          vehicleId: dto.vehicleId,
          trackerId: vehicle.tracker.id,
          fleetId: vehicle.fleetId,
          startedAt: draft.startedAt,
          endedAt: safeEndedAt,
          startLat: draft.startLat,
          startLng: draft.startLng,
          endLat: draft.endLat,
          endLng: draft.endLng,
          durationSeconds: safeDur,
          distanceMeters: Math.round(safeDist),
          distanceKm: Math.round(safeDist / 10) / 100,
          maxSpeed: safeMaxSpeed,
          avgSpeed: safeAvgSpeed,
          positionCount: draft.positionCount,
          segmentationSource: 'recompute',
          polyline: JSON.stringify(simplifiedPoly),
          // Le travail humain repris tel quel — y compris qui l'a écrit et quand.
          notes: ancien?.notes ?? null,
          notesUpdatedAt: ancien?.notesUpdatedAt ?? null,
          notesUpdatedById: ancien?.notesUpdatedById ?? null,
          driverId: ancien?.driverId ?? null,
          driverSource: ancien?.driverSource ?? null,
          missionId: ancien?.missionId ?? null,
        },
      });
      // Sprint G.3 — map-matching async pour les trips recomputes.
      this.runMapMatchingAsync(newTrip.id, simplifiedPoly);
      created++;
    }

    /**
     * Ce qui n'a trouvé aucun porteur : deux anciens trajets fondus en un seul, et un seul jeu
     * de notes peut y tenir. Le chiffre est rendu à l'appelant plutôt que tu — c'est la part
     * de la perte qu'on ne sait pas éviter, et la taire referait, en plus petit, le défaut
     * qu'on vient de corriger.
     */
    const notesPerdues = aReprendre.filter((t) => !dejaRepris.has(t.id) && t.notes != null).length;
    if (notesReprises > 0 || conducteursRepris > 0 || notesPerdues > 0) {
      this.logger.log(
        `Recalcul ${dto.vehicleId} : ${notesReprises} note(s) et ${conducteursRepris} conducteur(s) repris` +
          (notesPerdues > 0 ? `, ${notesPerdues} note(s) sans trajet d'accueil apres redecoupage` : ''),
      );
    }

    /**
     * ── JOURNAL SYSTÈME : LE SEUL GESTE DE LA PAGE QUI DÉTRUIT DES DONNÉES ─────────────
     *
     * Le recalcul supprime des trajets et en recrée d'autres. Jusqu'ici il ne laissait qu'une
     * ligne dans les journaux applicatifs du conteneur — c'est-à-dire nulle part pour qui
     * enquête depuis l'espace admin. Un client qui écrit « mes trajets d'août ont changé »
     * ne pouvait donc être ni confirmé ni démenti : personne ne savait qui avait recalculé
     * quoi, ni quand.
     *
     * ⚠️ `récits perdus` est journalisé même à zéro. C'est le chiffre qu'on vient chercher
     * après coup ; une ligne qui ne le porte que lorsqu'il est non nul oblige à interpréter
     * son absence, et une absence s'interprète toujours dans le sens qui arrange.
     *
     * Fire-and-forget : `record()` ne jette jamais. Un journal en panne ne doit pas faire
     * échouer un recalcul qui, lui, a bien eu lieu.
     */
    this.systemActivity?.record({
      category: 'MUTATION',
      action: 'trips_recompute',
      status: 'SUCCESS',
      // Le NOM est résolu à la lecture depuis `triggeredByUserId` ; le recopier ici
      // le figerait au moment du recalcul et le ferait diverger d'un renommage.
      actor: null,
      target: vehicle.plate ?? dto.vehicleId,
      fleetId: vehicle.fleetId,
      triggeredByUserId: requestedBy.userId ?? null,
      detail:
        `${deleted} trajet(s) supprimé(s), ${created} recréé(s) — `
        + `${notesReprises} note(s) et ${conducteursRepris} conducteur(s) repris, `
        + `${notesPerdues} note(s) sans trajet d'accueil`,
      meta: {
        vehicleId: dto.vehicleId,
        du: dto.from,
        au: dto.to,
        supprimes: deleted,
        recrees: created,
        notesReprises,
        conducteursRepris,
        notesPerdues,
      },
    });

    return { deleted, created, notesReprises, conducteursRepris, notesPerdues };
  }

  /**
   * L'ancien trajet dont la période RECOUVRE le mieux celle du nouveau, ou `null`.
   *
   * ⚠️ Un ancien trajet ne sert qu'une fois (`dejaRepris`) : ses notes ne peuvent pas être
   * recopiées sur deux trajets à la fois, sinon un même texte apparaîtrait deux fois et
   * personne ne saurait lequel fait foi.
   *
   * ⚠️ Un recouvrement NUL ne compte pas. Deux trajets qui se suivent sans se chevaucher n'ont
   * aucune raison de partager des notes : mieux vaut une note orpheline, comptée et annoncée,
   * qu'une note posée sur le mauvais trajet.
   */
  private ancienLeMieuxRecouvert<T extends { id: string; startedAt: Date; endedAt: Date | null }>(
    debut: Date,
    fin: Date,
    anciens: T[],
    dejaRepris: Set<string>,
  ): T | null {
    let meilleur: T | null = null;
    let meilleurRecouvrement = 0;
    for (const a of anciens) {
      if (dejaRepris.has(a.id)) continue;
      const aFin = a.endedAt ?? a.startedAt;
      const recouvrement =
        Math.min(fin.getTime(), aFin.getTime()) - Math.max(debut.getTime(), a.startedAt.getTime());
      if (recouvrement > meilleurRecouvrement) {
        meilleurRecouvrement = recouvrement;
        meilleur = a;
      }
    }
    return meilleur;
  }

  /**
   * Sprint G.3 — lance le map-matching OSRM en arriere-plan et persiste
   * `polylineMatched` une fois pret. Ne bloque jamais le caller.
   */
  private runMapMatchingAsync(tripId: string, points: Array<{ lat: number; lng: number }>): void {
    if (points.length < 2) return;
    void (async () => {
      try {
        const matched = await this.mapMatching.match(points);
        if (!matched || matched.length < 2) return;
        await this.prisma.trip.update({
          where: { id: tripId },
          data: { polylineMatched: JSON.stringify(matched) },
        });
        this.logger.log(`Map-matching OK pour trip ${tripId} (${points.length} -> ${matched.length} points)`);
      } catch (err) {
        this.logger.warn(`Map-matching async échec trip ${tripId} : ${err instanceof Error ? err.message : err}`);
      }
    })();
  }
}
