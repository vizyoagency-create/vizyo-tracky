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
import { evaluateIngestionFix, isPlausibleReportedSpeed, isValidLatLng, WS_EVENTS } from '@vizyo/tracky-shared';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GeofencesService } from '../geofences/geofences.service';
import { GpsDeadZonesService } from '../gps-dead-zones/gps-dead-zones.service';
import {
  estZoneParkingValidee,
  RESURFACE_SOMBRE_MIN_MS,
} from '../gps-dead-zones/presomption-stationnement';
import { SORTIE_HORS_CHAMP_EVENT, type SortieHorsChampEvent } from './sortie-hors-champ.event';
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

  /**
   * Silence au-delà duquel un épisode de perte GPS a pu être ouvert par le cron
   * d'intégrité — donc au-delà duquel une position valide vaut la peine d'aller
   * chercher un épisode à refermer.
   *
   * ⚠️ MÊME SOURCE QUE LE CRON (`GPS_LOST_ALERT_MIN`, 2 h par défaut). Deux constantes
   * qui divergent produiraient soit des épisodes jamais refermés — donc une durée
   * médiane calculée sur rien — soit une requête inutile sur chaque trame.
   */
  private readonly seuilEpisodeMs: number;

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
    private readonly deadZones: GpsDeadZonesService,
    // TRK-046 — sortie hors champ : émission d'événement, l'écouteur vit côté horaires.
    private readonly events: EventEmitter2,
  ) {
    const min = Number(process.env.GPS_LOST_ALERT_MIN);
    this.seuilEpisodeMs = (Number.isFinite(min) && min > 0 ? min : 120) * 60_000;
  }

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
      const verdict = !isPlausibleReportedSpeed(frame.speedKph)
        ? // ⚠️ LA VITESSE ANNONCEE PAR LE BOITIER, distincte de la vitesse IMPLIQUEE par le
          //    deplacement que verifie deja `evaluateIngestionFix`. Un boitier peut rouler a
          //    40 km/h, avec des positions parfaitement coherentes, et declarer 255 : le saut
          //    est plausible, la trame passe, et le chiffre absurde alimente les trajets, les
          //    scores de conduite et la detection d'exces. Releve du 20/08 : 147 positions
          //    au-dessus de 200 km/h sur un seul boitier, aucune ailleurs dans la flotte.
          //
          //    On REJETTE la trame plutot que de corriger la vitesse : inventer un chiffre
          //    serait pire que d'en refuser un faux. La position est perdue, l'historique garde
          //    un trou honnete plutot qu'une donnee fausse.
          ({ authoritative: false, reason: 'implausible_speed' as const })
        : evaluateIngestionFix(
            { lat: frame.latitude, lng: frame.longitude, deviceTime: frame.deviceTime },
            prevFix,
          );
      if (!verdict.authoritative) {
        // ══ TRK-015 — CE QU'ON PERSISTE ET CE QUI FAIT AUTORITÉ SONT DEUX DÉCISIONS ═════
        //
        // Le garde-fou ci-dessus est juste, et il doit rester : une trame antérieure prise
        // pour référence empoisonne la baseline, et c'est ce qui a produit la téléportation
        // en live, les distances négatives et les polylignes triangulaires (incident des
        // 10-11/06). Mais il prenait EN UNE SEULE décision deux questions distinctes :
        // « cette trame fait-elle foi ? » et « faut-il la garder ? ». La réponse à la
        // première est non ; à la seconde, souvent si.
        //
        // Mesuré en production sur 4 jours (24/08) : 10 015 trames écartées en
        // `stale_devicetime`, dont **5 908 SANS AUCUNE position à ± 60 s** — de la donnée
        // que la base n'a nulle part ailleurs. Un Coban qui tamponne pendant une coupure
        // 2G puis rejoue son tampon APRÈS que la trame temps réel a rétabli la baseline
        // voit tout son rattrapage déclaré « antérieur ». Épisode de bout en bout le
        // 08/08 : HD-779-MA entre dans un trou à 87 km/h, en ressort à 127 km/h six heures
        // plus tard, 1 643 trames rejetées, 15,7 km absents des rapports.
        //
        // LE DISCRIMINANT EST DANS LA DONNÉE, et il est net : un rejeu fantôme porte
        // EXACTEMENT l'horodatage d'une position déjà stockée ; un rattrapage n'a aucun
        // jumeau. Mesuré : sur les doublons exacts, 1 287 sur 1 302 ont leur jumeau (99 %)
        // — le garde-fou avait raison. Sur les retours en arrière, la majorité n'en a
        // aucun — il avait tort.
        //
        // ⚠️ HORODATAGE EXACT, PAS UNE FENÊTRE. Le ± 60 s ci-dessus sert à MESURER (il
        // sur-compte les jumeaux, donc sous-estime la perte : 5 908 est un plancher). Le
        // retenir comme test rejetterait des trames tamponnées légitimes — à 5 s de
        // cadence, une fenêtre de 60 s en couvre douze.
        //
        // ⚠️ CE QUE CETTE BRANCHE NE FAIT PAS, et c'est l'essentiel : elle n'écrit QUE la
        // ligne `positions`. Pas de dénormalisation (`lastLat`/`lastPositionAt`/
        // `lastValidFrameAt`), pas d'ignition — un fantôme `ignition=false` déclencherait
        // une fausse coupe externe —, pas de trip en direct, pas de diffusion temps réel.
        // La baseline reste protégée : c'est elle, et elle seule, que l'incident de juin a
        // empoisonnée. Les trajets récupèrent l'historique au recalcul du segmenteur, qui
        // relit `positions` dans l'ordre.
        const recuperee =
          verdict.reason === 'stale_devicetime'
            ? await this.recupererTrameTamponnee(tracker.id, frame, resolvedIgnition)
            : false;
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
              // TRK-015 — deux décisions distinctes, pour que la mesure reste possible :
              // ce qu'on a RÉCUPÉRÉ et ce qu'on continue d'ÉCARTER. Si les deux tombaient
              // à zéro, le garde-fou aurait été supprimé et non réparé.
              decision: recuperee ? 'RECOVERED_BUFFER' : 'SKIPPED_REPLAY',
              state,
              reason:
                `garde-fou ingestion (${verdict.reason}) : deviceTime ${frame.deviceTime.toISOString()} vs dernier ${lastDeviceTime?.toISOString() ?? '?'}` +
                (recuperee ? ' — RECUPEREE (aucune position a cet horodatage), non autoritaire' : ''),
              distanceM,
            },
            frame.speedKph,
            resolvedIgnition,
          )
          .catch(() => {
            /* swallowed in service */
          });
        this.logger.warn(
          `Trame non autoritaire ${recuperee ? 'RECUPEREE' : 'ignoree'} pour ${frame.imei} (${verdict.reason}) — ` +
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

    // TRK-040 — la batterie interne est la pente que le réexamen différé lit : on la
    // persiste à CHAQUE trame qui la porte (les trames position ordinaires, pas
    // seulement les alarmes — c'est ce qui aurait montré 96→83 % dès 07:00 sur
    // DZ-034-CA, cinq heures avant la première alerte).
    if (frame.batteryPercent !== undefined) {
      trackerUpdate.lastBatteryPercent = frame.batteryPercent;
      trackerUpdate.lastBatteryAt = new Date();
    }
    // TRK-040 — contact remis EXPLICITE (bit ignition ou trame kt) : sur un montage
    // commuté, le +12V revient avec le contact, l'épisode bénin se referme et le
    // soupçon avec. PAS sur l'inférence vitesse : un véhicule remorqué « roule »
    // aussi, et c'est précisément un cas de vol.
    if (resolvedIgnition === true && !ignitionInferredFromSpeed) {
      trackerUpdate.powerLossSuspectAt = null;
      trackerUpdate.powerLossSuspectBattery = null;
    }

    // V1.4 (Sprint 1 — hydratation au login) : denormalisation derniere position
    // connue. Mise à jour seulement quand la trame GPS est valide pour ne pas
    // ecraser une position fraiche par un fix degrade.
    if (frame.valid) {
      // ⚠️ TRK-028 — LE RETOUR DU SIGNAL SE MESURE ICI, ET NULLE PART AILLEURS.
      //
      // Cette trame est la PREMIERE position valide apres le silence : son `deviceTime`
      // est l'instant exact ou le vehicule est ressorti. Le cron d'integrite ne pourrait
      // pas le dire — il tourne toutes les 5 minutes et ne regarde que les boitiers SANS
      // fix, donc un vehicule ressorti a deja disparu de sa liste. Sur une absence
      // typique de quelques heures, une erreur de 5 minutes serait tolerable ; sur le
      // principe, lire l'instant reel ne coute rien de plus.
      //
      // ⚠️ ET LE FILTRE EST CE QUI REND LA CHOSE GRATUITE. Un episode n'existe qu'apres
      // `GPS_LOST_ALERT_MIN` (2 h par defaut) sans fix : on ne tente donc la fermeture
      // que si le silence a depasse ce seuil. Sur une trame ordinaire — l'ecrasante
      // majorite — il n'y a pas meme une requete. Sans ce filtre, on paierait un
      // `updateMany` par trame et par vehicule sur la route la plus chaude du systeme.
      const silenceMs = tracker.lastPositionAt
        ? frame.deviceTime.getTime() - tracker.lastPositionAt.getTime()
        : Number.POSITIVE_INFINITY;
      if (tracker.vehicleId && silenceMs >= this.seuilEpisodeMs) {
        void this.deadZones
          .recordRecovery({ vehicleId: tracker.vehicleId, at: frame.deviceTime })
          .catch((err) => {
            // Meme traitement que `recordLoss` cote cron : un echec ici ne doit pas
            // casser l'ingestion, mais il doit se voir au centre d'alerte — sinon on
            // reconstruit une cecite en croyant mesurer.
            this.errorLogger.recordBackground(
              err instanceof Error ? err : new Error(String(err)),
              'gps-dead-zones',
              { imei: frame.imei, vehicleId: tracker.vehicleId ?? undefined, phase: 'recordRecovery' },
            );
          });
      }

      // ══ TRK-046 — SORTIE HORS CHAMP : la réapparition EN MOUVEMENT se détecte ICI ══════
      //
      // Même logique de gratuité que le bloc TRK-028 ci-dessus : la transition « sans
      // position → position valide » n'existe qu'à CETTE trame, et le filtre (trou ≥ 10 min
      // ET vitesse > 5 km/h) écarte l'écrasante majorité des trames sans une seule requête.
      // Deux signatures de « hors champ », et seulement deux :
      //  - le boîtier émettait des trames `no_fix` pendant le trou (lastNoFixAt a avancé
      //    au-delà de la position figée) — parking où le GSM passe, tunnel ;
      //  - silence complet, mais l'ancre (lastLat/lastLng, figée à l'entrée) tombe dans un
      //    parking VALIDÉ — parking profond où le GSM meurt aussi. La requête de zone n'est
      //    payée QUE dans ce cas résiduel.
      // Un trou ≥ 10 min SANS ces signatures (ex. heartbeat horaire d'un véhicule garé
      // dehors) n'est PAS une sortie de champ : on n'émet rien.
      //
      // ⚠️ Limite assumée : si la PREMIÈRE trame de réapparition est à l'arrêt (barrière de
      // sortie) et que le véhicule ne roule que quelques trames plus tard, la transition est
      // consommée et la sortie n'est pas vue. En pratique une sortie de parking se fait en
      // roulant ; on documente plutôt que de persister un état par trame.
      if (
        tracker.vehicleId &&
        tracker.vehicle &&
        tracker.lastPositionAt &&
        frame.speedKph > 5 &&
        frame.deviceTime.getTime() - tracker.lastPositionAt.getTime() >= RESURFACE_SOMBRE_MIN_MS
      ) {
        void this.detecterSortieHorsChamp(tracker as Tracker & { vehicle: Vehicle }, frame).catch((err) => {
          this.logger.warn(
            `TRK-046 : détection de sortie hors champ impossible pour ${frame.imei} — ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }

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
      // TRK-056 — la fenetre glissante suit la mesure : sans elle, la mediane repartirait
      // de zero a chaque trame et `currentFixIntervalS` redeviendrait un echantillon.
      trackerUpdate.recentFixIntervalsS = reconciled.nextRecentFixIntervalsS;
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
   * TRK-046 — qualifie une réapparition en mouvement (trou ≥ 10 min) et émet l'événement
   * de sortie hors champ si — et seulement si — le trou était bien du HORS CHAMP :
   * trames `no_fix` pendant le trou, ou silence complet ancré dans un parking VALIDÉ.
   * L'écouteur (sortie-hors-horaire.service) décide seul du volet planning.
   *
   * Appelé AVANT l'écriture du trackerUpdate : tous les champs lus ici sont l'état
   * d'AVANT la trame (l'ancre lastLat/lastLng est encore le point d'entrée du lieu).
   */
  private async detecterSortieHorsChamp(
    tracker: Tracker & { vehicle: Vehicle },
    frame: CobanPositionFrame,
  ): Promise<void> {
    const sombreDepuis = tracker.lastPositionAt as Date; // garanti par l'appelant
    const signatureNoFix =
      tracker.lastNoFixAt != null && tracker.lastNoFixAt.getTime() > sombreDepuis.getTime();

    // La zone n'est interrogée qu'ici — jamais sur le chemin chaud : on est déjà sur la
    // trame rare d'une réapparition après ≥ 10 min de trou.
    const zone =
      tracker.vehicleId && tracker.lastLat != null && tracker.lastLng != null
        ? await this.deadZones.matchZoneForPoint(tracker.vehicleId, tracker.lastLat, tracker.lastLng)
        : null;
    const lieuValide = estZoneParkingValidee(zone);

    if (!signatureNoFix && !lieuValide) return; // trou sans signature hors champ : rien à dire

    const evt: SortieHorsChampEvent = {
      trackerId: tracker.id,
      imei: tracker.imei,
      vehicleId: tracker.vehicleId as string,
      fleetId: tracker.vehicle.fleetId,
      plate: tracker.vehicle.plate,
      at: frame.deviceTime.toISOString(),
      sombreDepuis: sombreDepuis.toISOString(),
      sombreMs: frame.deviceTime.getTime() - sombreDepuis.getTime(),
      speedKmh: frame.speedKph,
      lat: frame.latitude,
      lng: frame.longitude,
      lieuValide,
    };
    this.events.emit(SORTIE_HORS_CHAMP_EVENT, evt);
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
  /**
   * TRK-015 — récupère une trame antérieure QUAND elle n'est pas un fantôme.
   *
   * Le test qui sépare les deux tient en une requête : un rejeu fantôme porte
   * **exactement** l'horodatage d'une position déjà stockée ; un rattrapage de tampon n'a
   * aucun jumeau. Mesuré le 24/08 sur 4 jours de production : 1 287 des 1 302 doublons
   * exacts ont leur jumeau (99 % — le garde-fou avait raison), tandis que 5 908 trames
   * écartées n'ont aucune position à ± 60 s (le garde-fou avait tort).
   *
   * @returns `true` si une ligne `positions` a été écrite (rattrapage), `false` si la
   *   trame est un fantôme prouvé, ou si l'écriture a échoué.
   *
   * ⚠️ ÉCRIT LA POSITION, ET RIEN D'AUTRE. Aucune dénormalisation sur le tracker, aucune
   * ignition, aucun trip, aucune diffusion : c'est ce qui distingue « persister » de
   * « faire autorité ». L'appelant conserve son comportement de liveness inchangé.
   *
   * ⚠️ NE LÈVE JAMAIS. Une récupération est un bonus : si elle échoue, on retombe
   * exactement sur le comportement d'avant ce correctif — la trame est écartée et
   * journalisée. Laisser une exception remonter ferait perdre AUSSI la mise à jour de
   * liveness, donc ferait passer un boîtier bien vivant pour hors ligne.
   *
   * ⚠️ Il n'existe pas de contrainte d'unicité sur `(trackerId, timestamp)` : deux trames
   * identiques traitées en parallèle pourraient toutes deux passer le test et créer un
   * doublon. La fenêtre est de quelques millisecondes et les deux lignes porteraient la
   * même donnée — c'est un prix très inférieur à la perte qu'on répare ici. À reconsidérer
   * si la mesure montre des doublons réels.
   */
  private async recupererTrameTamponnee(
    trackerId: string,
    frame: CobanPositionFrame,
    ignition: boolean | undefined,
  ): Promise<boolean> {
    try {
      const jumeau = await this.prisma.position.findFirst({
        where: { trackerId, timestamp: frame.deviceTime },
        select: { id: true },
      });
      // Fantôme prouvé : la position existe déjà. Comportement d'avant, strictement.
      if (jumeau) return false;

      await this.prisma.position.create({
        data: {
          trackerId,
          lat: frame.latitude,
          lng: frame.longitude,
          speedKmh: frame.speedKph,
          heading: frame.course ?? 0,
          valid: frame.valid,
          ignition: ignition ?? null,
          timestamp: frame.deviceTime,
        },
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `TRK-015 : récupération de trame tamponnée impossible pour ${frame.imei} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

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
