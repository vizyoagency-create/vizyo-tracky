import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CommandStatus, EngineAction, Prisma, UserRole } from '@prisma/client';
import type { Position, Tracker, Vehicle } from '@prisma/client';
import type { CobanPositionFrame, PositionUpdateEvent } from '@vizyo/tracky-shared';
import { evaluateIngestionFix, isValidLatLng, WS_EVENTS } from '@vizyo/tracky-shared';
import { GeofencesService } from '../geofences/geofences.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { PositionBroadcastBuffer } from '../realtime/position-broadcast-buffer.service';
import { PositionBatchBufferService } from './position-batch-buffer.service';
import { resolveEffectivePrivacy } from '../privacy-mode/effective-privacy';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TrackerFixModeService } from '../tracker-fix-mode/tracker-fix-mode.service';
import { TripsService } from '../trips/trips.service';
import { PositionSamplingService } from './position-sampling.service';

/** Only consider app CUT commands within this window for ignition confirmation. */
const CUT_DETECTION_WINDOW_MS = 5 * 60 * 1000;

interface RequestedBy {
  role: UserRole | string;
  fleetId: string | null;
  /** Liste des vehicleIds accessibles, ou 'ALL' = aucun filtre granulaire. */
  accessibleVehicleIds?: string[] | 'ALL';
}

@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    private readonly geofences: GeofencesService,
    private readonly trips: TripsService,
    private readonly errorLogger: ErrorLogger,
    private readonly sampling: PositionSamplingService,
    private readonly broadcastBuffer: PositionBroadcastBuffer,
    private readonly fixMode: TrackerFixModeService,
    private readonly batchBuffer: PositionBatchBufferService,
  ) {}

  async ingest(frame: CobanPositionFrame): Promise<void> {
    const tracker = await this.prisma.tracker.findUnique({
      where: { imei: frame.imei },
      include: { vehicle: { include: { fleet: true, workSchedule: true } } },
    });

    if (!tracker) {
      this.logger.warn(`Position for unknown IMEI ${frame.imei}, skipping`);
      return;
    }

    // Mode vie privée EFFECTIF — privé manuel OU hors temps de travail (cadre calendrier), cf.
    // resolveEffectivePrivacy. Quand privé, AUCUNE position n'est collectée : on JETTE la trame ici
    // (avant toute persistance/diffusion/trajet/géofence) → « safe forgetting » du hors-travail SANS
    // rétro-activation (la donnée n'existe pas). Le boîtier COMMUNIQUE quand même → on rafraîchit la
    // liveness (lastSeenAt + ONLINE) : il reste « en ligne », sa dernière position connue reste figée.
    // Fail-safe : une erreur de résolution ne doit NI crasher l'ingestion NI perdre le suivi. En cas
    // d'erreur inattendue on retombe sur le seul flag manuel (privacyModeEnabled) et on remonte au
    // centre d'alerte (source `privacy-resolve`).
    let effectivePrivacy: { isPrivate: boolean } | null = null;
    if (tracker.vehicle) {
      try {
        effectivePrivacy = resolveEffectivePrivacy(tracker.vehicle, tracker.vehicle.workSchedule, new Date());
      } catch (err) {
        this.errorLogger
          .record(err instanceof Error ? err : new Error(String(err)), 'privacy-resolve', { trackerId: tracker.id }, 'ERROR')
          .catch(() => undefined);
        effectivePrivacy = { isPrivate: !!tracker.vehicle.privacyModeEnabled };
      }
    }
    if (effectivePrivacy?.isPrivate) {
      const wasOffline = tracker.status !== 'ONLINE';
      await this.prisma.tracker.update({
        where: { id: tracker.id },
        data: { lastSeenAt: new Date(), status: 'ONLINE' },
      });
      if (wasOffline && tracker.vehicle) {
        this.gateway.emitTrackerStatus(tracker.vehicle.fleetId, {
          trackerId: tracker.id,
          imei: tracker.imei,
          status: 'online',
          at: new Date().toISOString(),
        });
      }
      return;
    }

    // Resolve ignition from binary field OR acc alarm
    let resolvedIgnition: boolean | undefined = frame.ignition;
    if (resolvedIgnition === undefined) {
      if (frame.alarm === 'acc_on') resolvedIgnition = true;
      else if (frame.alarm === 'acc_off') resolvedIgnition = false;
    }

    // V1.7 — Heuristique vitesse pour les trackers dont le fil ACC n'est pas
    // physiquement connecte (Tracker.accConnected = false). Sans signal ACC,
    // on infere ignition depuis la vitesse GPS : >3 km/h => moteur forcement ON.
    // Le seuil 3 km/h s'aligne sur PositionSamplingService.MOVING_SPEED_KMH
    // pour rester coherent avec la classification d'état.
    //
    // A vitesse <= 3 : on garde l'etat precedent (lastKnownIgnition). Le passage
    // a OFF se fera via le cron IgnitionInferredCleanupService (P3) qui tournera
    // chaque minute et eteindra l'ignition apres 5 min sans trame valide.
    let ignitionInferredFromSpeed = false;
    if (!tracker.accConnected && resolvedIgnition === undefined && frame.valid) {
      if (frame.speedKph > 3) {
        resolvedIgnition = true;
        ignitionInferredFromSpeed = true;
      }
    }

    // V1.4 (Sprint 4 — gps-sanity) : rejet defensif des coordonnees hors-bornes
    // ou a Null Island, meme si le protocole les marque valid:true.
    if (!isValidLatLng(frame.latitude, frame.longitude)) {
      this.logger.warn(
        `Position rejetee pour ${frame.imei} : lat/lng hors-bornes ou Null Island ` +
          `(${frame.latitude}, ${frame.longitude})`,
      );
      // V1.17 (Sprint 0.1) — le boitier COMMUNIQUE (trame recue), seul le fix
      // GPS est hors-bornes. On met a jour la liveness (lastSeenAt + ONLINE)
      // AVANT de sortir — comme la garde anti-replay plus bas — sinon un boitier
      // qui n'emet QUE des fixes invalides (demarrage a froid, indoor, Null
      // Island) n'apparait jamais "vu" et reste OFFLINE a tort. Pas de denorm
      // position (le fix est invalide), pas de broadcast. Cf. docs/sprint-0.1.
      const wasOffline = tracker.status !== 'ONLINE';
      await this.prisma.tracker.update({
        where: { id: tracker.id },
        data: { lastSeenAt: new Date(), status: 'ONLINE' },
      });
      if (wasOffline && tracker.vehicle) {
        this.gateway.emitTrackerStatus(tracker.vehicle.fleetId, {
          trackerId: tracker.id,
          imei: tracker.imei,
          status: 'online',
          at: new Date().toISOString(),
        });
      }
      return;
    }

    // V1.17 (gps-sanity ingestion) — garde-fou anti-replay / anti-teleportation.
    // Certains boitiers Coban rejouent leur buffer interne : entrelacees au flux
    // temps reel, des trames au `deviceTime` ANTERIEUR (ou a un saut infaisable)
    // arrivent pour le meme IMEI a une position distante de plusieurs km (analyse
    // prod HD-779-MA, nuit 2026-06-10/11). Persistees, elles polluent `positions`,
    // les trips et les rapports de distance.
    //
    // On les detecte ICI (avant toute denormalisation) et on les traite comme NON
    // AUTORITAIRES : seule la liveness (lastSeenAt/status) est mise à jour. Pas de
    // denorm position (sinon le fantome empoisonne la baseline du prochain calcul
    // de distance), pas de sampling, pas de trip, pas de broadcast — et surtout
    // pas de maj ignition (un fantome ignition=false declencherait un faux
    // "CUT externe" via handleIgnitionTransition).
    //
    // Le meme invariant (deviceTime strictement croissant + saut < 250 km/h) est
    // deja applique en aval par TripsService.processPosition ; on le remonte a
    // l'ingestion pour empecher l'ecriture de la ligne `positions` elle-meme.
    if (frame.valid) {
      const lastDeviceTime = tracker.lastValidFrameAt ?? tracker.lastPositionAt;
      const prevFix =
        tracker.lastLat != null && tracker.lastLng != null && lastDeviceTime != null
          ? { lat: tracker.lastLat, lng: tracker.lastLng, deviceTime: lastDeviceTime }
          : null;
      const verdict = evaluateIngestionFix(
        { lat: frame.latitude, lng: frame.longitude, deviceTime: frame.deviceTime },
        prevFix,
      );
      if (!verdict.authoritative) {
        const wasOffline = tracker.status !== 'ONLINE';
        // Liveness uniquement — le boitier communique bien, c'est la trame qui ment.
        await this.prisma.tracker.update({
          where: { id: tracker.id },
          data: { lastSeenAt: new Date(), status: 'ONLINE' },
        });
        if (wasOffline && tracker.vehicle) {
          this.gateway.emitTrackerStatus(tracker.vehicle.fleetId, {
            trackerId: tracker.id,
            imei: tracker.imei,
            status: 'online',
            at: new Date().toISOString(),
          });
        }
        // Audit : la trame fantome apparait dans `position_sampling_decisions`
        // (decision SKIPPED_REPLAY) — la table ou le bug a ete diagnostique.
        const { state, distanceM } = this.sampling.classify({
          speedKmh: frame.speedKph,
          ignition: resolvedIgnition,
          lat: frame.latitude,
          lng: frame.longitude,
          prevLat: tracker.lastLat,
          prevLng: tracker.lastLng,
        });
        this.sampling
          .recordDecision(
            tracker.id,
            {
              shouldInsert: false,
              decision: 'SKIPPED_REPLAY',
              state,
              reason: `garde-fou ingestion (${verdict.reason}) : deviceTime ${frame.deviceTime.toISOString()} vs dernier ${lastDeviceTime?.toISOString() ?? '?'}`,
              distanceM,
            },
            frame.speedKph,
            resolvedIgnition,
          )
          .catch(() => {
            /* swallowed in service */
          });
        this.logger.warn(
          `Trame non autoritaire ignoree pour ${frame.imei} (${verdict.reason}) — ` +
            `deviceTime ${frame.deviceTime.toISOString()}` +
            (distanceM != null ? `, saut ${(distanceM / 1000).toFixed(2)} km vs derniere position` : ''),
        );
        return;
      }
    }

    // Always update tracker state (ignition + lastSeenAt), even for invalid GPS.
    const trackerUpdate: Prisma.TrackerUpdateInput = {
      lastSeenAt: new Date(),
      status: 'ONLINE',
    };

    const ignitionChanged =
      resolvedIgnition !== undefined &&
      tracker.lastKnownIgnition !== null &&
      tracker.lastKnownIgnition !== resolvedIgnition;

    if (resolvedIgnition !== undefined) {
      trackerUpdate.lastKnownIgnition = resolvedIgnition;
      // Synchroniser lastIgnition (lu par le snapshot) meme si le GPS est invalide,
      // sinon un acc_off avec GPS invalide laisse lastIgnition stale = true.
      trackerUpdate.lastIgnition = resolvedIgnition;
      if (ignitionChanged || tracker.lastKnownIgnition === null) {
        trackerUpdate.lastIgnitionChangeAt = new Date();
      }
    }

    // V1.4 (Sprint 1 — hydratation au login) : denormalisation derniere position
    // connue. Mise à jour seulement quand la trame GPS est valide pour ne pas
    // ecraser une position fraiche par un fix degrade.
    if (frame.valid) {
      trackerUpdate.lastLat = frame.latitude;
      trackerUpdate.lastLng = frame.longitude;
      trackerUpdate.lastSpeedKmh = frame.speedKph;
      trackerUpdate.lastHeading = frame.course ?? 0;
      trackerUpdate.lastValid = frame.valid;
      trackerUpdate.lastPositionAt = frame.deviceTime;
    }

    // V1.5 (Sprint H1) — sampling adaptatif. Calcule sur les trames valides
    // uniquement (les invalides ne sont jamais persistees, sampling sans objet).
    // L'outcome alimente trackerUpdate (lastWriteAt + lastSampledState) et
    // pilote le `prisma.position.create` plus bas. Le broadcast WS reste
    // integral quel que soit l'outcome (UX-first).
    let samplingOutcome: ReturnType<PositionSamplingService['decide']> | null = null;
    let samplingState: ReturnType<PositionSamplingService['classify']>['state'] | null = null;
    if (frame.valid) {
      const adaptiveEnabled = tracker.vehicle?.fleet?.adaptiveSamplingEnabled ?? true;
      const { state, distanceM } = this.sampling.classify({
        speedKmh: frame.speedKph,
        ignition: resolvedIgnition,
        lat: frame.latitude,
        lng: frame.longitude,
        prevLat: tracker.lastLat,
        prevLng: tracker.lastLng,
      });
      samplingState = state;
      samplingOutcome = this.sampling.decide(tracker, state, distanceM, adaptiveEnabled);

      if (samplingOutcome.shouldInsert) {
        trackerUpdate.lastWriteAt = new Date();
        trackerUpdate.lastSampledState = samplingOutcome.state;
      }

      // V1.5 (Sprint H3) — reconcile observed fix interval. Compare deltaT entre
      // deviceTime de cette trame et lastValidFrameAt pour detecter si le boitier
      // honore l'intervalle desire (ou si on doit incrementer le compteur d'echec).
      const reconciled = this.fixMode.reconcile(tracker, {
        deviceTime: frame.deviceTime,
        speedKmh: frame.speedKph,
        ignition: resolvedIgnition,
        lat: frame.latitude,
        lng: frame.longitude,
      });
      trackerUpdate.currentFixIntervalS = reconciled.nextCurrentFixIntervalS;
      trackerUpdate.fixCommandFailureCount = reconciled.nextFailureCount;
      trackerUpdate.fixCommandFailing = reconciled.nextFailing;
      trackerUpdate.lastValidFrameAt = frame.deviceTime;

      // V1.14 — Auto-alignement : si le boitier ignore les commandes de maniere
      // recurrente, on aligne desired sur son intervalle reel pour sortir de la
      // boucle FAILING. Le tracker est "accepte" tel quel.
      if (reconciled.autoAlignDesiredS != null) {
        trackerUpdate.desiredFixIntervalS = reconciled.autoAlignDesiredS;
        trackerUpdate.fixCommandFailing = false;
        trackerUpdate.fixCommandFailureCount = 0;
        this.logger.log(
          `Auto-align: tracker ${tracker.imei} desired ajuste a ${reconciled.autoAlignDesiredS}s (accepte le comportement firmware)`,
        );
      }

      // V1.14 — Resolution des commandes stale : quand le tracker vient de passer
      // FAILING (transition false→true), on ferme toutes les commandes SENT/PENDING
      // pour eviter qu'elles restent indefiniment sans statut final.
      if (reconciled.nextFailing && !tracker.fixCommandFailing) {
        this.prisma.trackerCommand
          .updateMany({
            where: {
              trackerId: tracker.id,
              templateId: 'fix_continuous',
              status: { in: ['SENT', 'PENDING'] },
            },
            data: {
              status: 'FAILED',
              observedResult: `Tracker FAILING — ${reconciled.nextFailureCount} trames non conformes (intervalle observe: ${reconciled.nextCurrentFixIntervalS ?? '?'}s)`,
            },
          })
          .catch((err) => {
            this.logger.warn(`Failed to close stale fix commands for ${tracker.imei}: ${err}`);
          });
      }
    }

    const wasOffline = tracker.status !== 'ONLINE';
    await this.prisma.tracker.update({
      where: { id: tracker.id },
      data: trackerUpdate,
    });

    // Persist sampling decision (fire-and-forget — audit non critique).
    if (samplingOutcome) {
      this.sampling
        .recordDecision(tracker.id, samplingOutcome, frame.speedKph, resolvedIgnition)
        .catch(() => {
          /* swallowed in service */
        });
    }

    if (wasOffline && tracker.vehicle) {
      this.gateway.emitTrackerStatus(tracker.vehicle.fleetId, {
        trackerId: tracker.id,
        imei: tracker.imei,
        status: 'online',
        at: new Date().toISOString(),
      });
    }

    // Fix veilleur — transition « en mouvement ». Le veilleur de nuit ne reçoit AUCUNE
    // position ; on lui pousse un simple booléen (roule/à l'arrêt) pour qu'il puisse
    // griser le bouton « Couper » sur un véhicule en marche. Émis SEULEMENT au changement
    // d'état → volume négligeable. Seuil aligné sur REST_SPEED_KMH (5 km/h) du garde
    // coupe-moteur ; le serveur reste le rempart final (engine-control.service).
    if (tracker.vehicle) {
      const MOVING_SPEED_KMH = 5;
      const prevMoving =
        tracker.lastKnownIgnition === true && (tracker.lastSpeedKmh ?? 0) > MOVING_SPEED_KMH;
      const effIgnition = resolvedIgnition ?? tracker.lastKnownIgnition ?? false;
      // La vitesse ne se met à jour que sur trame valide ; sinon on conserve la dernière connue.
      const effSpeed = frame.valid ? frame.speedKph : tracker.lastSpeedKmh ?? 0;
      const newMoving = effIgnition === true && effSpeed > MOVING_SPEED_KMH;
      if (newMoving !== prevMoving) {
        this.gateway.emitVehicleMovement(tracker.vehicle.fleetId, {
          trackerId: tracker.id,
          fleetId: tracker.vehicle.fleetId,
          moving: newMoving,
        });
      }
    }

    // Detect ignition transitions for SMS bypass / relay reset
    if (ignitionChanged && tracker.vehicle) {
      this.handleIgnitionTransition(
        tracker as Tracker & { vehicle: Vehicle },
        tracker.lastKnownIgnition!,
        resolvedIgnition!,
      ).catch((err) => {
        this.logger.error('Ignition transition handling failed', err);
        this.errorLogger.record(err instanceof Error ? err : new Error(String(err)), 'positions', { imei: frame.imei, trackerId: tracker.id }).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
      });
    }

    // For invalid GPS: broadcast ignition-only update but skip position persistence
    if (!frame.valid) {
      this.logger.debug(`Invalid GPS fix for ${frame.imei}, skipping position persistence`);
      if (tracker.vehicle && resolvedIgnition !== undefined) {
        // Broadcast ignition update via last known position or minimal event
        const event: PositionUpdateEvent = {
          trackerId: tracker.id,
          vehicleId: tracker.vehicle.id,
          fleetId: tracker.vehicle.fleetId,
          lat: frame.latitude,
          lng: frame.longitude,
          speedKmh: frame.speedKph,
          heading: frame.course ?? 0,
          timestamp: frame.deviceTime.toISOString(),
          ignition: resolvedIgnition,
          valid: false,
        };
        this.gateway.broadcastPosition(tracker.vehicle.fleetId, event);
      }
      return;
    }

    // V1.5 (Sprint H3) — pilotage fix mode boitier. Sur transition d'etat, on
    // demande au boitier d'ajuster son intervalle d'envoi via la commande
    // Coban `fix...***n`. Fire-and-forget : l'echec n'impacte pas l'ingestion.
    // V1.14 — On verifie trackerUpdate.fixCommandFailing (valeur post-reconcile)
    // au lieu de tracker.fixCommandFailing (valeur pre-reconcile, race condition).
    if (samplingState && tracker.vehicle?.fleet && !trackerUpdate.fixCommandFailing) {
      const stateChanged = tracker.lastSampledState !== samplingState;
      const desiredS = this.fixMode.desiredIntervalFor(samplingState, tracker);
      if (stateChanged || desiredS !== tracker.desiredFixIntervalS) {
        this.fixMode
          .requestChange(
            tracker as Tracker & { vehicle: Vehicle & { fleet: NonNullable<typeof tracker.vehicle>['fleet'] } },
            desiredS,
            stateChanged ? `${tracker.lastSampledState ?? 'NEW'}_TO_${samplingState}` : `${samplingState}_INTERVAL_ADJUSTED`,
            {
              vehicleId: tracker.vehicle.id,
              fleetId: tracker.vehicle.fleetId,
              plate: tracker.vehicle.plate,
              speedKmh: frame.speedKph,
              ignition: resolvedIgnition ?? null,
              latitude: frame.latitude,
              longitude: frame.longitude,
              previousState: tracker.lastSampledState,
              newState: samplingState,
              lastSeenAt: tracker.lastSeenAt?.toISOString() ?? null,
              lastIgnitionChangeAt: tracker.lastIgnitionChangeAt?.toISOString() ?? null,
            },
          )
          .catch((err) => {
            this.logger.warn(
              `Fix mode requestChange failed for ${tracker.imei}: ${err instanceof Error ? err.message : err}`,
            );
          });
      }
    }

    // V1.5 (Sprint H1) — persistance Position conditionnee par le sampling.
    // Quand `shouldInsert = false`, on conserve uniquement la denormalisation
    // sur Tracker (deja faite plus haut) et l'audit dans `position_sampling_decisions`.
    //
    // V1.10 (Sprint 2 perf) — enqueue dans le batch buffer au lieu d'un
    // `position.create` synchrone. Flush periodique (100ms) en `createMany`.
    // La derniere position connue reste a jour en temps reel via Tracker.last*
    // mis a jour plus haut — pas de regression UX.
    if (samplingOutcome?.shouldInsert) {
      this.batchBuffer.enqueue({
        trackerId: tracker.id,
        lat: frame.latitude,
        lng: frame.longitude,
        speedKmh: frame.speedKph,
        heading: frame.course ?? 0,
        altitude: frame.altitude,
        valid: frame.valid,
        ignition: resolvedIgnition ?? null,
        timestamp: frame.deviceTime,
      });
    }

    if (tracker.vehicle) {
      // Fallback : utiliser le dernier etat connu du tracker plutot que d'assumer ON.
      // Securite : si aucune info, on ne presume pas que le moteur tourne.
      const ignitionValue = resolvedIgnition ?? tracker.lastKnownIgnition ?? false;

      // V1.7 — log debug pour tracer les ignitions inferees (mode degrade ACC).
      if (ignitionInferredFromSpeed) {
        this.logger.debug(
          `[ACC degraded] ${tracker.imei} : ignition inferee depuis vitesse ` +
            `(${frame.speedKph.toFixed(1)} km/h > 3) -> ON`,
        );
      }
      const event: PositionUpdateEvent = {
        trackerId: tracker.id,
        vehicleId: tracker.vehicle.id,
        fleetId: tracker.vehicle.fleetId,
        lat: frame.latitude,
        lng: frame.longitude,
        speedKmh: frame.speedKph,
        heading: frame.course ?? 0,
        timestamp: frame.deviceTime.toISOString(),
        ignition: ignitionValue,
        valid: frame.valid,
      };
      // Broadcast WS systematique (UX-first), independant du sampling DB.
      // V1.5 (Sprint H1) — coalescing 1s : on enqueue dans le buffer plutot
      // que d'emit immediatement. Si le buffer est desactive (env var), il
      // retourne false et on fallback sur l'emit immediat legacy.
      const buffered = this.broadcastBuffer.enqueue(tracker.vehicle.fleetId, event);
      if (!buffered) {
        this.gateway.broadcastPosition(tracker.vehicle.fleetId, event);
      }

      this.geofences.checkViolations(
        tracker.id, frame.latitude, frame.longitude,
        tracker.vehicle.fleetId, tracker.vehicle.id, tracker.imei,
      ).catch((err) => {
        this.logger.error('Geofence check failed', err);
        this.errorLogger.record(err instanceof Error ? err : new Error(String(err)), 'geofences', { imei: frame.imei, trackerId: tracker.id }).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
      });

      // Trip processing only on actually persisted positions — sinon on
      // dupliquerait la segmentation sur des trames quasi identiques.
      if (samplingOutcome?.shouldInsert) {
        this.trips.processPosition({
          trackerId: tracker.id,
          vehicleId: tracker.vehicle.id,
          fleetId: tracker.vehicle.fleetId,
          lat: frame.latitude,
          lng: frame.longitude,
          speedKmh: frame.speedKph,
          timestamp: frame.deviceTime,
          ignition: ignitionValue,
          vehiclePlate: tracker.vehicle.plate,
        }).catch((err) => {
          this.logger.error('Trip processing failed', err);
          this.errorLogger.record(err instanceof Error ? err : new Error(String(err)), 'trips', { imei: frame.imei, trackerId: tracker.id }).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
        });
      }
    }
  }

  /**
   * Confirmation par ignition d'une coupure moteur APP en attente.
   *
   * On NE synthétise PLUS de commande « coupure/rallumage externe » (DEVICE_OBSERVED)
   * sur les cycles de contact. Un contact qui passe OFF = stationnement dans
   * l'immense majorité des cas, INDISTINGUABLE d'une vraie coupure externe : l'ancienne
   * heuristique faisait apparaître TOUT véhicule garé comme « coupé » (bouton
   * « Rallumer » à tort, pour les veilleurs comme pour tous les rôles), et polluait la
   * base à chaque cycle de contact. L'état coupé est désormais 100 % piloté par les
   * commandes app réelles (MANUAL/SCHEDULER), source de vérité unique et prévisible.
   *
   * SEUL cas traité ici : quand l'ignition tombe juste après une coupure app ENVOYÉE
   * et CONFIRMABLE (`confirmationExpected` = véhicule en marche à l'envoi), c'est la
   * preuve physique que la coupure a fonctionné → on passe la commande ACKNOWLEDGED
   * (état « confirmée », distinct de « envoyée ») + WS. Jamais de faux succès.
   */
  private async handleIgnitionTransition(
    tracker: Tracker & { vehicle: Vehicle },
    previousIgnition: boolean,
    currentIgnition: boolean,
  ): Promise<void> {
    // On ne réagit qu'à une transition contact ON -> OFF (chute d'ignition).
    if (previousIgnition !== true || currentIgnition !== false) return;

    const recentCut = await this.prisma.engineControlCommand.findFirst({
      where: {
        trackerId: tracker.id,
        action: EngineAction.CUT,
        // Coupure APP uniquement (jamais une observation device) + encore non confirmée.
        source: { not: 'DEVICE_OBSERVED' },
        status: CommandStatus.SENT,
        confirmationExpected: true,
        createdAt: { gte: new Date(Date.now() - CUT_DETECTION_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!recentCut) return;

    try {
      const confirmed = await this.prisma.engineControlCommand.update({
        where: { id: recentCut.id },
        data: { status: CommandStatus.ACKNOWLEDGED, ackedAt: new Date() },
      });
      this.gateway.emitEngineCommandUpdate(tracker.vehicle.fleetId, {
        commandId: confirmed.id,
        trackerId: tracker.id,
        action: confirmed.action,
        status: confirmed.status,
        lastError: null,
        confirmationExpected: confirmed.confirmationExpected,
        sentAt: confirmed.sentAt ? confirmed.sentAt.toISOString() : null,
        ackedAt: confirmed.ackedAt ? confirmed.ackedAt.toISOString() : null,
        source: confirmed.source as 'MANUAL' | 'SCHEDULER' | 'DEVICE_OBSERVED',
      });
      this.logger.log(
        { trackerId: tracker.id, commandId: confirmed.id },
        'Engine CUT confirmee par chute d\'ignition',
      );
    } catch (err) {
      this.logger.error(
        { trackerId: tracker.id, error: (err as Error).message },
        'Failed to persist ignition confirmation',
      );
    }
  }

  async list(
    requestedBy: RequestedBy,
    filters: {
      trackerId?: string;
      vehicleId?: string;
      limit?: string;
      from?: string;
      to?: string;
      cursor?: string;
    },
  ): Promise<{ items: Position[]; nextCursor: string | null }> {
    let trackerId = filters.trackerId;
    const scopedIds =
      requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL'
        ? requestedBy.accessibleVehicleIds
        : null;

    if (!trackerId && filters.vehicleId) {
      // Filtre tenant + acces granulaire integres au where : 404 plutot que 403
      // pour ne pas leak l'existence du vehicule.
      const vehicleWhere: Prisma.VehicleWhereInput = { id: filters.vehicleId };
      if (requestedBy.role !== UserRole.SUPER_ADMIN) {
        if (!requestedBy.fleetId) throw new NotFoundException('Véhicule introuvable');
        vehicleWhere.fleetId = requestedBy.fleetId;
      }
      if (scopedIds) vehicleWhere.id = { in: scopedIds.includes(filters.vehicleId) ? [filters.vehicleId] : [] };
      const vehicle = await this.prisma.vehicle.findFirst({
        where: vehicleWhere,
        include: { tracker: true },
      });
      if (!vehicle) throw new NotFoundException('Véhicule introuvable');
      if (!vehicle.tracker) return { items: [], nextCursor: null };
      trackerId = vehicle.tracker.id;
    }

    if (!trackerId) {
      throw new BadRequestException('trackerId ou vehicleId requis');
    }

    const tracker = await this.prisma.tracker.findUnique({
      where: { id: trackerId },
      include: { vehicle: true },
    });
    if (!tracker) throw new NotFoundException('Tracker introuvable');

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!tracker.vehicle || tracker.vehicle.fleetId !== requestedBy.fleetId) {
        throw new NotFoundException('Tracker introuvable');
      }
    }
    // Acces granulaire : le vehicule porte par le tracker doit etre autorise.
    if (scopedIds && tracker.vehicle && !scopedIds.includes(tracker.vehicle.id)) {
      throw new NotFoundException('Tracker introuvable');
    }

    // Mode vie privée (RGPD) — tant qu'il est ACTIF, on ne renvoie AUCUNE position
    // historique de ce véhicule (masquage, pas suppression : réapparaît si désactivé).
    if (tracker.vehicle?.privacyModeEnabled) {
      return { items: [], nextCursor: null };
    }

    const where: Prisma.PositionWhereInput = { trackerId };
    if (filters.from || filters.to) {
      where.timestamp = {};
      if (filters.from) (where.timestamp as any).gte = new Date(filters.from);
      if (filters.to) (where.timestamp as any).lte = new Date(filters.to);
    }

    const limit = Math.min(filters.limit ? parseInt(filters.limit, 10) : 100, 500);
    const items = await this.prisma.position.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }
}
