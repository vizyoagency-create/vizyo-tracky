import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { CommandStatus, EngineAction, GpsDeadZoneStatus, Prisma, UserRole } from '@prisma/client';
import type { EngineControlCommand, GpsDeadZone } from '@prisma/client';
import type { CobanCommand } from '@vizyo/tracky-shared';
import { DORMANT_STOP_ACTING_MS, encodeCommand, formatSilenceLabel, trackerSilenceMs } from '@vizyo/tracky-shared';
import { GpsDeadZonesService } from '../gps-dead-zones/gps-dead-zones.service';
import {
  estHorsChampGps,
  estZoneParkingValidee,
  libelleZoneParking,
} from '../gps-dead-zones/presomption-stationnement';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { resolveTenantScope } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SMS_INBOUND_EVENT, SmsGatewayService } from '../sms/sms-gateway.service';
import type { SmsInboundEvent } from '../sms/sms-gateway.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { AckWaiterService } from '../tracker-commands/ack-waiter.service';
import { computeNextTransition } from '../vehicle-schedules/schedule-evaluator';

const STALE_THRESHOLD_MOVING_MS = 60 * 1000; // position fraîche exigée si véhicule roulait
const REST_SPEED_KMH = 5; // en-dessous = véhicule à l'arrêt, pas de seuil stale
const MAX_SPEED_FOR_CUT = 20;
/**
 * Sprint 3 — durée minimale d'immobilité avant qu'un VEILLEUR puisse couper
 * (anti-coupure d'un véhicule en mouvement). Env plateforme `ENGINE_CUT_MIN_STOPPED_S`
 * (défaut 120 s). RÉSERVÉ au rôle NIGHT_WATCHMAN ; les admins/managers gardent la
 * coupe S2 (≤ 20 km/h, antivol préservé).
 */
const ENGINE_CUT_MIN_STOPPED_MS = Math.max(0, Number(process.env.ENGINE_CUT_MIN_STOPPED_S) || 120) * 1000;
/**
 * Coupe AUTOMATIQUE (planning horaire, source `SCHEDULER`) — durée minimale d'immobilité
 * avant que l'automatisation coupe le moteur. Demande CDEF (2026-07) : l'automatisation ne
 * doit JAMAIS couper un véhicule en mouvement, ni un véhicule à peine arrêté ; on attend un
 * arrêt RÉEL prolongé (défaut 600 s = 10 min). Distinct de la coupe admin (antivol ≤ 20 km/h,
 * inchangée) et de la règle veilleur (gérée par rôle) : ici on branche sur la SOURCE. Appliqué
 * à TOUTES les flottes, réglable par l'env plateforme `SCHEDULE_CUT_MIN_STOPPED_S`. Le cron
 * traite le refus comme un REPORT (retry au tick suivant), pas comme une erreur.
 */
const SCHEDULE_CUT_MIN_STOPPED_MS = Math.max(0, Number(process.env.SCHEDULE_CUT_MIN_STOPPED_S) || 600) * 1000;
/**
 * Sprint 3 (Option A) — une COUPE VEILLEUR est une intervention de sécurité de nuit : elle
 * doit TENIR jusqu'à réactivation manuelle (RESTORE), pas être défaite par le planning au bout
 * de l'override habituel (1h). On suspend donc le planning « sans échéance » via cette sentinelle
 * lointaine (le scheduler skip tant que `overrideUntil > now`, cf schedule-cron.service:111). Le
 * planning reste `enabled` ; un RESTORE (n'importe quel acteur) repose ensuite une grâce 1h normale.
 */
const WATCHMAN_HOLD_UNTIL = new Date('9999-12-31T23:59:59.000Z');
const ENGINE_ACK_TIMEOUT_MS = 15_000;
const ENGINE_STOP_ACK_PATTERN = /imei:\d{15},J/i;
const ENGINE_RESUME_ACK_PATTERN = /imei:\d{15},K/i;

/**
 * TRK-036 — les accuses du boitier sur le canal SMS.
 *
 * ⚠️ RIEN A VOIR avec les deux patterns ci-dessus, et il ne faut pas les confondre : ceux-la
 * lisent la TRAME TCP (`imei:…,J`), ceux-ci lisent un SMS en clair. Le boitier repond en
 * anglais, gabarit fixe, observe deux fois en production : « Stop engine Succeed » le
 * 2026-07-13 et « Resume engine Succeed » le 2026-08-19.
 */
const ACCUSE_SMS_MOTEUR: ReadonlyArray<{ motif: RegExp; action: EngineAction }> = [
  { motif: /stop\s+engine\s+succeed/i, action: EngineAction.CUT },
  { motif: /resume\s+engine\s+succeed/i, action: EngineAction.RESTORE },
];
/**
 * Priorite haute des ACK moteur (#7) : leurs patterns J/K sont specifiques, mais
 * une commande generique concurrente (status/position_single, pattern large) ne
 * doit pas "voler" l'echo moteur. Priorite > 0 => resolu en premier dans tryMatch.
 */
const ENGINE_ACK_PRIORITY = 10;

/**
 * Sprint 2 — Fenêtre de confirmation par ignition (env `ENGINE_CONFIRM_WINDOW_S`,
 * défaut 90 s ≈ 2-3 trames Coban). Sert au verrou « une coupure en vol » (Obj 1)
 * et à la sentinelle d'observabilité « coupure non confirmée » (Obj 5). La doc
 * protocole (03 §11) cite 120 s — ajustable via l'env sans redéploiement de code.
 */
const ENGINE_CONFIRM_WINDOW_MS =
  Math.max(10, Number(process.env.ENGINE_CONFIRM_WINDOW_S) || 90) * 1000;

/**
 * TRK-018 — échéance d'une commande moteur restée `SENT` sans accusé.
 *
 * Env `ENGINE_COMMAND_EXPIRY_MIN`, défaut **30 min**. Très au-delà de la fenêtre d'ACK
 * (15 s) et de la fenêtre de confirmation par ignition (90 s) : passé ce délai, plus aucun
 * mécanisme existant ne peut confirmer la commande, et la laisser ouverte ne fait
 * qu'allonger une file que rien ne solde. Mesuré le 24/08 : **313 commandes `SENT`, dont
 * 307 de plus de 24 h, 0 acquittée depuis l'origine.**
 */
const ENGINE_COMMAND_EXPIRY_MS =
  Math.max(1, Number(process.env.ENGINE_COMMAND_EXPIRY_MIN) || 30) * 60 * 1000;

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

/**
 * ══ TRK-046 — le refus « véhicule considéré stationné » a son PROPRE TYPE ═══════════════════
 *
 * Le cron des horaires ne discrimine les refus QUE par type d'exception (revue de
 * schedule-cron : les `msg.includes(...)` avalaient des erreurs par coïncidence de
 * sous-chaîne). Un état bénin qui mérite un traitement différent — pas de compteur de
 * blocage, pas d'alerte « coupe impossible », re-vérification espacée — doit donc être un
 * TYPE, pas un préfixe de message. Hérite de ForbiddenException : tout appelant qui ignore
 * cette nuance retombe sur le comportement « report » sûr d'aujourd'hui.
 */
export class PresumedParkedException extends ForbiddenException {}

@Injectable()
export class EngineControlService implements OnModuleDestroy {
  private readonly logger = new Logger(EngineControlService.name);

  /**
   * Timers armés par la sentinelle « coupure non confirmée ». SUIVIS pour pouvoir les annuler à
   * l'arrêt du module : un timer de 90 s qui survit à son contexte se réveille dans un monde qui
   * n'existe plus (Prisma en cours de fermeture, ou — en test — la suite suivante). Cf. l'instabilité
   * des tests diagnostiquée le 2026-07-20.
   */
  private readonly confirmTimers = new Set<NodeJS.Timeout>();

  /** Arrêt propre : on annule ce qui était armé plutôt que de le laisser se réveiller dans le vide. */
  onModuleDestroy(): void {
    for (const timer of this.confirmTimers) clearTimeout(timer);
    this.confirmTimers.clear();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionRegistry: SocketRegistryService,
    private readonly wireLogger: CobanWireLogger,
    private readonly ackWaiter: AckWaiterService,
    private readonly gateway: RealtimeGateway,
    private readonly errorLogger: ErrorLogger,
    private readonly sms: SmsGatewayService,
    private readonly deadZones: GpsDeadZonesService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /**
   * ══ TRK-018 — DONNER UNE FIN DE VIE AUX COMMANDES MOTEUR ═══════════════════════════════
   *
   * Rien ne soldait jamais ces lignes : la file n'était plus une file. Mesuré le 2026-08-24 :
   * **313 commandes `SENT`, dont 307 de plus de 24 h, et 0 acquittée depuis l'origine** —
   * 153 d'entre elles parties par le repli SMS. Un véhicule est immobilisé et redémarré
   * chaque nuit par un canal dont aucun étage ne peut dire s'il transmet.
   *
   * ── POURQUOI `SENT_UNCONFIRMED` ET PAS `FAILED` ────────────────────────────────────────
   *
   * « A échoué » et « nul ne sait » ne sont pas la même information. Les confondre ferait
   * croire à une panne là où il n'y a qu'une absence de preuve — et le coupe-circuit est une
   * garde de sécurité : *une garde qu'on croit armée sans preuve est plus dangereuse qu'une
   * garde qu'on sait muette.* L'état neuf dit exactement ce qu'on sait, ni plus ni moins.
   *
   * ── L'ÉCHÉANCE EST PUREMENT TEMPORELLE ─────────────────────────────────────────────────
   *
   * ⚠️ C'est la leçon de [TRK-007], et elle a déjà été payée : conditionner la clôture à un
   * état du boîtier la ferait retomber dans le piège qu'elle prétend fermer — on attendrait
   * une confirmation qui n'arrive jamais pour fermer une ligne ouverte faute de confirmation.
   * Le `where` ci-dessous ne regarde donc QUE l'horloge et le statut.
   *
   * ⚠️ Et on ne conclut RIEN sur l'issue réelle. C'est la leçon de [TRK-013] en miroir : là
   * le défaut était d'affirmer un échec sans comparer ; ici, il n'y a rien à comparer, donc
   * on n'affirme rien. `lastError` reste vide — il n'y a pas d'erreur.
   *
   * ⚠️ **NE PAS marquer ces commandes acquittées d'office.** Écrire `ackedAt` ferait
   * disparaître les 313 lignes et supprimerait la seule trace de la question. *Le témoin
   * n'est pas le défaut.*
   */
  @Cron('0 */10 * * * *')
  async cloturerCommandesPerimees(): Promise<void> {
    try {
      const echeance = new Date(Date.now() - ENGINE_COMMAND_EXPIRY_MS);
      const { count } = await this.prisma.engineControlCommand.updateMany({
        where: {
          status: CommandStatus.SENT,
          ackedAt: null,
          sentAt: { lt: echeance },
        },
        data: { status: CommandStatus.SENT_UNCONFIRMED, expiredAt: new Date() },
      });
      if (count > 0) {
        this.logger.log(
          `TRK-018 : ${count} commande(s) moteur close(s) en SENT_UNCONFIRMED (échéance ${ENGINE_COMMAND_EXPIRY_MS / 60000} min).`,
        );
      }
    } catch (err) {
      // Journalisé, jamais propagé : un balayage qui échoue ne doit pas emporter le cron.
      this.logger.warn(
        `TRK-018 : clôture des commandes périmées impossible — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * TRK-036 — un SMS entrant peut etre l'ACCUSE d'une commande moteur partie en repli SMS.
   *
   * ── CE QUE CE CHEMIN REPARE ──────────────────────────────────────────────────────────
   *
   * Le repli SMS n'avait AUCUNE preuve de remise ([TRK-018]) : 280 commandes au statut
   * « envoye », dont 274 depuis plus de 24 h. Le 2026-08-19, le boitier de GS-014-NY a
   * pourtant repondu « Resume engine Succeed » — recu par la passerelle, ecrit dans
   * `sms_logs`, et jamais rapproche de la commande creee 3 h 50 plus tot.
   *
   * ── LE RAPPROCHEMENT SE FAIT SUR (BOITIER, ACTION), PAS SUR LE TEMPS ─────────────────
   *
   * ⚠️ 3 h 50 separaient la commande de sa reponse. Une fenetre temporelle assez large pour
   * couvrir ce cas rattacherait n'importe quel accuse a n'importe quelle commande de la
   * demi-journee. Le couple (boitier, action) est le bon discriminant : un « Resume » ne
   * peut confirmer qu'un RESTORE, et seulement pour le boitier qui l'a envoye.
   *
   * ── CE QU'IL NE FAUT PAS EN CONCLURE ─────────────────────────────────────────────────
   *
   * ⚠️ Ce chemin explique pourquoi on ne VOYAIT pas les accuses. Il n'explique pas pourquoi
   * il n'y en a que DEUX en cinq semaines pour 280 commandes. Les deux questions sont
   * distinctes et [TRK-018] reste ouverte.
   */
  @OnEvent(SMS_INBOUND_EVENT)
  async onAccuseSmsMoteur(evt: SmsInboundEvent): Promise<void> {
    try {
      const attendu = ACCUSE_SMS_MOTEUR.find((a) => a.motif.test(evt.body ?? ''));
      if (!attendu) return;

      const cle = (evt.fromNumber ?? '').replace(/\D/g, '').slice(-9);
      if (cle.length < 9) return;

      const trackers = await this.prisma.tracker.findMany({
        where: { simPhoneNumber: { endsWith: cle } },
        select: { id: true, imei: true, vehicle: { select: { fleetId: true } } },
        take: 2,
      });
      // Ambiguite = abstention : cf. `resoudreImeiParSim`. Confirmer une coupure moteur sur
      // le mauvais vehicule est plus grave que ne rien confirmer.
      if (trackers.length !== 1) return;
      const tracker = trackers[0];

      const commande = await this.prisma.engineControlCommand.findFirst({
        where: { trackerId: tracker.id, action: attendu.action, status: CommandStatus.SENT },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true },
      });
      if (!commande) {
        this.logger.debug(
          { imei: tracker.imei, action: attendu.action },
          'Accuse SMS moteur recu, mais aucune commande en attente pour ce boitier',
        );
        return;
      }

      // `updateMany` avec le statut dans le `where` : un second SMS identique ne reecrit pas
      // un acquittement deja pose. Le chemin est rejouable sans effet de bord.
      const { count } = await this.prisma.engineControlCommand.updateMany({
        where: { id: commande.id, status: CommandStatus.SENT },
        data: { status: CommandStatus.ACKNOWLEDGED, ackedAt: new Date() },
      });
      if (count === 0) return;

      const latenceMs = Date.now() - new Date(commande.createdAt).getTime();
      this.logger.log(
        { commandId: commande.id, imei: tracker.imei, action: attendu.action, latenceMs },
        'Commande moteur ACQUITTEE par accuse SMS du boitier',
      );

      const acked = await this.prisma.engineControlCommand.findUnique({
        where: { id: commande.id },
      });
      if (acked && tracker.vehicle?.fleetId) this.emitUpdate(acked, tracker.vehicle.fleetId);
    } catch (err) {
      // Un ecouteur d'evenement qui leve casse le flux entrant pour TOUS les abonnes —
      // dont la machine a etats de provisionnement. On journalise, on n'interrompt rien.
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Echec du rapprochement d\'un accuse SMS moteur',
      );
    }
  }

  async requestCommand(
    trackerId: string,
    action: EngineAction,
    reason: string | null,
    requestedBy: RequestedBy,
    source: 'MANUAL' | 'SCHEDULER' = 'MANUAL',
    disableSchedule?: boolean,
    preserveSchedule?: boolean,
  ): Promise<EngineControlCommand> {
    // V1.10 (Sprint 6) — IDOR fix : filtre tenant integre au where pour
    // empecher un user d'envoyer un CUT/RESTORE sur un tracker d'une autre
    // flotte en enumerant les trackerId.
    const trackerWhere: Prisma.TrackerWhereInput = { id: trackerId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Tracker introuvable');
      trackerWhere.vehicle = { fleetId: requestedBy.fleetId };
    }
    const tracker = await this.prisma.tracker.findFirst({
      where: trackerWhere,
      include: { vehicle: { include: { fleet: true } } },
    });

    if (!tracker) {
      throw new NotFoundException('Tracker introuvable');
    }

    if (!tracker.vehicle) {
      throw new BadRequestException('Tracker non associé à un véhicule');
    }

    const fleetId = tracker.vehicle.fleetId;

    // ── COUPE AUTOMATIQUE sur boîtier DORMANT : on ne tente pas ──────────────
    // Un boîtier muet depuis des jours ne répondra ni en TCP ni en SMS. Le
    // planning retentait donc indéfiniment, empilant commandes et alertes.
    //
    // ⚠️ PÉRIMÈTRE VOLONTAIREMENT MINIMAL — `CUT` **et** `SCHEDULER` seulement.
    // C'est l'asymétrie déjà posée par le planning : rater une coupe est un
    // désagrément, rater une RESTAURATION immobilise un véhicule. Un boîtier a
    // très bien pu être réellement coupé alors qu'il était vivant, puis se taire :
    // si la dormance bloquait `RESTORE`, il resterait coupé pour toujours, sans
    // même une tentative SMS. Et une action MANUELLE (ex. immobiliser un véhicule
    // volé) doit garder TCP + repli SMS, y compris sur un boîtier silencieux —
    // c'est précisément là qu'on veut tenter notre chance.
    if (source === 'SCHEDULER' && action === EngineAction.CUT) {
      const silentMs = trackerSilenceMs(tracker.lastSeenAt);
      if (silentMs != null && silentMs > DORMANT_STOP_ACTING_MS) {
        // ForbiddenException = « report » côté cron : aucune commande persistée,
        // aucun événement WS émis. Le planning reprend seul dès la première trame.
        throw new ForbiddenException(
          `Coupe auto suspendue : boîtier muet depuis ${formatSilenceLabel(tracker.lastSeenAt)}`,
        );
      }
    }

    // Sprint 2 (Obj 1 + revue) — verrou « une coupure en vol » : rejet d'une NOUVELLE
    // coupure MANUELLE tant qu'une coupure confirmable précédente attend sa
    // confirmation (ignition). N'affecte PAS le RESTORE (échappatoire sûr), ni les
    // commandes SCHEDULER (qui re-évaluent à chaque tick), ni une coupure « non
    // vérifiable » (à l'arrêt, confirmationExpected=false). La fenêtre borne aussi
    // les PENDING orphelins (anti-blocage permanent si un dispatch a échoué/crashé).
    if (action === EngineAction.CUT && source === 'MANUAL') {
      const windowStart = new Date(Date.now() - ENGINE_CONFIRM_WINDOW_MS);
      const inflight = await this.prisma.engineControlCommand.findFirst({
        where: {
          trackerId,
          action: EngineAction.CUT,
          ackedAt: null,
          createdAt: { gte: windowStart },
          OR: [
            { status: CommandStatus.PENDING },
            { status: CommandStatus.SENT, confirmationExpected: true },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (inflight) {
        this.logger.warn({ trackerId, blockedBy: inflight.id }, 'Engine CUT rejected: command already in flight');
        throw new ConflictException(
          'Une coupure est déjà en cours sur ce véhicule (en attente de confirmation).',
        );
      }
    }

    // Sprint 2 (Obj 2) — une chute d'ignition est-elle attendable comme preuve ?
    let confirmationExpected = false;

    if (action === EngineAction.CUT) {
      const lastPosition = await this.prisma.position.findFirst({
        where: { trackerId },
        orderBy: { timestamp: 'desc' },
      });

      if (!lastPosition) {
        return this.rejectSpeed(
          { trackerId, action, reason, userId: requestedBy.userId, source },
          fleetId,
          'Aucune position connue pour ce tracker',
        );
      }

      const ageMs = Date.now() - lastPosition.timestamp.getTime();
      // À l'arrêt (≤5 km/h) → pas de seuil stale, le véhicule est garé sans risque.
      // En mouvement → position fraîche exigée pour confirmer la vitesse actuelle.
      const isAtRest = lastPosition.speedKmh <= REST_SPEED_KMH;

      // Revue (incident FS-253) : ce garde « stale » NE s'applique PAS au SCHEDULER. Pour l'auto-cut,
      // une dernière vitesse FIGÉE et VIEILLE (boîtier GPS muet depuis des heures = véhicule garé) ne
      // prouve AUCUN mouvement — l'appliquer bloquait la coupe pour toujours (74 REJECTED_SPEED/j) et
      // le véhicule restait « en mouvement » à l'écran. Le SCHEDULER décide via le mouvement RÉCENT
      // (scan de trames fraîches ci-dessous), jamais via lastPosition périmée. Admin/veilleur inchangés.
      if (source !== 'SCHEDULER' && !isAtRest && ageMs > STALE_THRESHOLD_MOVING_MS) {
        return this.rejectSpeed(
          { trackerId, action, reason, userId: requestedBy.userId, source },
          fleetId,
          `Position trop ancienne (${Math.round(ageMs / 1000)}s, seuil ${Math.round(STALE_THRESHOLD_MOVING_MS / 1000)}s)`,
          'Position trop ancienne (stale)',
        );
      }

      if (!lastPosition.valid) {
        return this.rejectSpeed(
          { trackerId, action, reason, userId: requestedBy.userId, source },
          fleetId,
          'Fix GPS invalide',
        );
      }

      // Demande CDEF (2026-07) — COUPE AUTOMATIQUE (source SCHEDULER) : ne JAMAIS couper un
      // véhicule en mouvement, et attendre un arrêt RÉEL prolongé (SCHEDULE_CUT_MIN_STOPPED_MS,
      // défaut 10 min) avant de couper. On branche sur la SOURCE (pas le rôle : le scheduler
      // s'identifie SUPER_ADMIN) pour ne PAS toucher aux politiques admin (≤ 20 km/h) et veilleur.
      // On DIFFÈRE sans créer de commande (throw sec) : le cron capte le ForbiddenException et
      // réessaie au tick suivant, sans empiler une REJECTED_SPEED à chaque minute (anti-bloat DB/WS).
      // PLACÉ AVANT le garde antivol ≤ 20 km/h (revue) : sinon un véhicule > 20 km/h retomberait
      // sur rejectSpeed() qui PERSISTE une commande + émet un WS à chaque tick → le bloat qu'on
      // voulait éviter. Ici, TOUT véhicule en mouvement (> 5 km/h) en SCHEDULER = throw sec.
      if (source === 'SCHEDULER') {
        // ══ TRK-046 — VÉHICULE HORS CHAMP GPS : la vitesse figée ne décide plus ══════════
        //
        // Mesuré le 25/08 sur FZ-862-VY : entré dans un souterrain à 27,15 km/h, plus un
        // seul fix pendant 7,7 h — et 13 refus « Vitesse trop élevée : 27.15 km/h »
        // d'affilée, sur une vitesse datée de la veille. Le garde stale ci-dessus avait
        // reçu l'exemption SCHEDULER en juillet avec EXACTEMENT le bon raisonnement
        // (« une vitesse figée ne prouve AUCUN mouvement ») ; le garde de vitesse, lui,
        // relisait la même valeur périmée soixante lignes plus bas. Deux issues, décidées
        // par le LIEU de la perte (décision du propriétaire, 25/08) :
        //
        //  1. Le lieu est un parking VALIDÉ (souterrain/couvert, auto-qualifié ou revu) →
        //     comportement NORMAL d'un GPS sous terre : le véhicule est CONSIDÉRÉ
        //     STATIONNÉ. Aucune commande (elle n'atteindrait pas le boîtier), aucun refus
        //     persisté, aucune alerte « coupe impossible » — le type d'exception dédié
        //     dit au cron de re-vérifier calmement. Le filet de sécurité est la SORTIE :
        //     réapparaître en roulant hors horaire déclenche l'alerte OFF_SCHEDULE_MOVEMENT.
        //  2. Lieu inconnu → on ne coupe PAS à l'aveugle (un tunnel ne produit aucune
        //     position : le scan d'immobilité ci-dessous serait aveugle à un véhicule qui
        //     roule sans ciel), on DIFFÈRE avec la cause honnête. L'alerte « coupe
        //     impossible » reste — c'est elle qui pousse à qualifier le lieu.
        //
        // ⚠️ Un véhicule hors champ dont la dernière vitesse était ≤ 5 km/h (perdu À
        // L'ARRÊT) suit le chemin historique : le scan d'immobilité ne trouve rien et la
        // coupe part — comportement de juillet (FS-253), conservé.
        if (estHorsChampGps(tracker, Date.now())) {
          if (tracker.powerLossSuspectAt == null) {
            const zone = await this.zoneParkingValideePourAncre(tracker.vehicleId, tracker.lastLat, tracker.lastLng);
            if (zone) {
              throw new PresumedParkedException(
                `Coupe auto en veille : véhicule hors champ GPS dans un lieu validé (${libelleZoneParking(zone)}) — ` +
                  `considéré stationné, sortie surveillée`,
              );
            }
          }
          if (!isAtRest) {
            const horsChampMin = Math.round(ageMs / 60000);
            throw new ForbiddenException(
              `Coupe auto différée : véhicule hors champ GPS depuis ${horsChampMin} min — ` +
                `dernière vitesse connue (${lastPosition.speedKmh} km/h) datée d'avant la perte, non probante`,
            );
          }
        }
        // 1) En mouvement RÉELLEMENT (position FRAÎCHE > 5 km/h) → jamais de coupe auto, on diffère.
        // La fraîcheur (age ≤ STALE_THRESHOLD_MOVING_MS) est exigée : une dernière vitesse PÉRIMÉE
        // (boîtier silencieux depuis des heures = garé, cf incident FS-253) ne prouve pas un mouvement
        // en cours ; on ne bloque donc plus la coupe dessus. Le mouvement RÉCENT est vérifié en (2).
        if (!isAtRest && ageMs <= STALE_THRESHOLD_MOVING_MS) {
          throw new ForbiddenException(
            `Coupe auto différée : véhicule en mouvement (${lastPosition.speedKmh} km/h)`,
          );
        }
        // 2) À l'arrêt mais pas depuis assez longtemps ? On cherche une trame EN MOUVEMENT
        // (> 5 km/h) dans [now - SCHEDULE_CUT_MIN_STOPPED_MS ; now] (index [trackerId, timestamp desc],
        // scan borné). Si trouvée → arrêt trop récent → on diffère jusqu'à immobilité sur toute la
        // fenêtre. Sinon (garé depuis ≥ la fenêtre, même simple heartbeat récent) → coupe autorisée.
        if (SCHEDULE_CUT_MIN_STOPPED_MS > 0) {
          const windowStart = new Date(Date.now() - SCHEDULE_CUT_MIN_STOPPED_MS);
          const recentMovement = await this.prisma.position.findFirst({
            where: { trackerId, speedKmh: { gt: REST_SPEED_KMH }, timestamp: { gte: windowStart } },
            orderBy: { timestamp: 'desc' },
            select: { timestamp: true },
          });
          if (recentMovement) {
            const stoppedForMs = Date.now() - recentMovement.timestamp.getTime();
            // ⚠️ Libellé PARSÉ par schedule-cron (TRK-029, parseKnownCountdown) : N et M y
            // deviennent un réessai programmé à M − N s. Reformuler ici = retomber en silence
            // sur le backoff exponentiel (dégradation sûre, mais 25 min de coupe en trop).
            throw new ForbiddenException(
              `Coupe auto différée : véhicule arrêté depuis seulement ${Math.round(stoppedForMs / 1000)}s ` +
                `(minimum requis ${Math.round(SCHEDULE_CUT_MIN_STOPPED_MS / 1000)}s)`,
            );
          }
        }
      }

      // ⚠️ TRK-046 — pour la source SCHEDULER, ce garde est un FILET, plus jamais le juge :
      // un véhicule en mouvement FRAIS est déjà différé plus haut (> 5 km/h), et une vitesse
      // PÉRIMÉE est traitée par le bloc « hors champ » (considéré stationné ou report
      // honnête). S'il se déclenche encore en SCHEDULER, c'est qu'un chemin a été oublié —
      // le REJECTED_SPEED persisté rendra alors l'oubli visible au lieu de le masquer.
      if (lastPosition.speedKmh > MAX_SPEED_FOR_CUT) {
        return this.rejectSpeed(
          { trackerId, action, reason, userId: requestedBy.userId, source },
          fleetId,
          `Vitesse trop élevée : ${lastPosition.speedKmh} km/h`,
        );
      }

      // Sprint 3 — règle « immobile depuis X min », RÉSERVÉE AU VEILLEUR (NIGHT_WATCHMAN).
      // Les admins/managers gardent la coupe S2 (≤ 20 km/h) → antivol préservé. Le veilleur
      // ne peut couper qu'un véhicule à l'arrêt (≤ REST_SPEED_KMH) ET immobile depuis au moins
      // ENGINE_CUT_MIN_STOPPED_MS — c.-à-d. AUCUNE trame > REST_SPEED_KMH dans la fenêtre.
      if (requestedBy.role === UserRole.NIGHT_WATCHMAN) {
        const reject = (lastError: string): Promise<never> =>
          this.rejectSpeed({ trackerId, action, reason, userId: requestedBy.userId, source }, fleetId, lastError);

        // 1) Actuellement en mouvement (> 5 km/h) — refusé même si ≤ 20 (qui passerait pour un admin).
        // `return reject(...)` (et pas `await`) : défense en profondeur — rejectSpeed lève déjà,
        // mais le `return` garantit qu'aucune coupe ne peut se poursuivre si sa sémantique changeait.
        if (lastPosition.speedKmh > REST_SPEED_KMH) {
          return reject(`Véhicule en mouvement (${lastPosition.speedKmh} km/h) — coupure réservée à l'arrêt`);
        }

        // 2) Immobile depuis assez longtemps ? On cherche une trame EN MOUVEMENT (> 5 km/h)
        // dans la fenêtre [now - ENGINE_CUT_MIN_STOPPED_MS ; now] (bornée → 1 index-scan
        // [trackerId, timestamp desc]). Si on en trouve une, le véhicule a bougé trop
        // récemment → refus. Sinon (garé depuis ≥ la fenêtre, même heartbeat récent) → OK.
        const windowStart = new Date(Date.now() - ENGINE_CUT_MIN_STOPPED_MS);
        const recentMovement = await this.prisma.position.findFirst({
          where: { trackerId, speedKmh: { gt: REST_SPEED_KMH }, timestamp: { gte: windowStart } },
          orderBy: { timestamp: 'desc' },
          select: { timestamp: true },
        });
        if (recentMovement) {
          const stoppedForMs = Date.now() - recentMovement.timestamp.getTime();
          return reject(
            `Véhicule arrêté depuis seulement ${Math.round(stoppedForMs / 1000)}s — minimum requis ${Math.round(
              ENGINE_CUT_MIN_STOPPED_MS / 1000,
            )}s`,
          );
        }
      }

      // Sprint 2 (Obj 2) — garde-fous passés : si l'ignition est ON, une chute
      // d'ignition confirmera la coupure. Si déjà à l'arrêt → pas de transition
      // observable → la commande sera affichée « non vérifiable ».
      confirmationExpected = lastPosition.ignition === true;
    }

    // Action manuelle → on NE désactive JAMAIS le mode horaire (seul le toggle explicite de la page
    // Horaires le fait). On SUSPEND le planning jusqu'à sa PROCHAINE bascule programmée, puis il
    // reprend automatiquement. Le cron n'agit qu'aux transitions (schedule-cron:139), donc l'action
    // manuelle « tient » jusqu'au prochain créneau (ex : rallumage à 1h → tient jusqu'à 8h, puis le
    // planning reprend et recoupe à 22h). Deux exceptions :
    //   (a) veilleur qui COUPE = hold indéfini (intervention sécu de nuit, tient jusqu'à un RESTORE) ;
    //   (b) `disableSchedule:true` explicite (case « immobilisation durable / hors planning », anti-vol)
    //       = SEULE voie manuelle qui met enabled=false.
    // `preserveSchedule` (déverrouillage conducteur) → on NE touche PAS au planning : le RESTORE est
    // TRANSITOIRE. Le scheduler n'agit qu'aux transitions (state === lastEvaluatedState → skip, cf.
    // schedule-cron:139), donc l'état tient jusqu'à la prochaine bascule SANS suspension ni override.
    // Décision produit : un conducteur ne doit JAMAIS interrompre le mode horaire de la flotte.
    if (source === 'MANUAL' && !preserveSchedule) {
      const vehicle = tracker.vehicle;
      if (vehicle) {
        const isWatchman = requestedBy.role === UserRole.NIGHT_WATCHMAN;
        // Le veilleur ne gère PAS les plannings (gate `schedules_manage`) : `disableSchedule` est
        // ignoré pour lui (sinon le gate horaires serait contourné via la commande moteur).
        const mayDisableSchedule = disableSchedule && !isWatchman;
        try {
          const schedule = await this.prisma.vehicleSchedule.findFirst({
            where: { vehicleId: vehicle.id, enabled: true },
          });
          if (!schedule) {
            // Aucun planning actif → rien à neutraliser.
          } else if (mayDisableSchedule) {
            // Désactivation DURABLE explicite (sortie du planning, anti-vol) — seul chemin enabled=false.
            await this.prisma.vehicleSchedule.updateMany({
              where: { vehicleId: vehicle.id, enabled: true },
              data: { enabled: false, lastEvaluatedState: null, lastEvaluatedAt: null },
            });
            this.logger.log({ vehicleId: vehicle.id }, 'Schedule disabled by manual engine command (durable opt-in)');
          } else if (isWatchman && action === EngineAction.CUT) {
            // Coupe veilleur = intervention sécu de nuit : tient JUSQU'À réactivation manuelle
            // (override « indéfini »). Le planning reste `enabled` ; un RESTORE reposera une
            // suspension normale (branche else) qui expirera à la prochaine bascule.
            await this.prisma.vehicleSchedule.updateMany({
              where: { vehicleId: vehicle.id, enabled: true },
              data: { overrideUntil: WATCHMAN_HOLD_UNTIL },
            });
            this.logger.log({ vehicleId: vehicle.id }, 'Watchman cut — schedule held until manual restore');
          } else {
            // Action manuelle standard (CUT ou RESTORE, admin/manager/conducteur) → suspension
            // jusqu'à la PROCHAINE bascule programmée (8h/22h…), puis le planning reprend seul.
            // Le mode reste `enabled`. Fallback 1h si planning toujours ouvert/fermé (pas de bascule).
            const next = computeNextTransition(schedule);
            const overrideUntil = next ? next.at : new Date(Date.now() + 60 * 60 * 1000);
            await this.prisma.vehicleSchedule.updateMany({
              where: { vehicleId: vehicle.id, enabled: true },
              data: { overrideUntil },
            });
            this.logger.log(
              { vehicleId: vehicle.id, overrideUntil, nextAction: next?.action ?? 'none' },
              'Schedule suspended until next transition (manual action)',
            );
          }
        } catch (err) {
          this.logger.error({ vehicleId: vehicle.id, error: (err as Error).message },
            'Failed to update schedule — scheduler may conflict with manual command');
        }
      }
    }

    const command = await this.prisma.engineControlCommand.create({
      data: {
        trackerId,
        action,
        reason,
        requestedBy: requestedBy.userId,
        source,
        status: CommandStatus.PENDING,
        confirmationExpected,
      },
    });

    if (command.status === CommandStatus.PENDING) {
      // Palier B — journalise la commande moteur (arrière-plan / device). SUCCESS = commande
      // livrée (TCP ou SMS) ; FAILURE = dispatch impossible. L'ACK/confirmation détaillé reste
      // dans l'onglet « Commandes moteur ». Les refus (REJECTED_SPEED) lèvent avant ce point.
      try {
        await this.dispatchCommand(tracker.imei, command, action, fleetId);
        this.recordSystemActivity(action, tracker.vehicle, reason, requestedBy, source, fleetId, 'SUCCESS');
      } catch (err) {
        this.recordSystemActivity(action, tracker.vehicle, reason, requestedBy, source, fleetId, 'FAILURE');
        throw err;
      }
    }

    return command;
  }

  /** Palier B — trace la commande moteur (coupe-circuit) dans le journal des actions système. */
  private recordSystemActivity(
    action: EngineAction,
    vehicle: { id: string; plate: string | null } | null,
    reason: string | null,
    requestedBy: RequestedBy,
    source: 'MANUAL' | 'SCHEDULER',
    fleetId: string,
    status: 'SUCCESS' | 'FAILURE',
  ): void {
    this.systemActivity.record({
      category: 'ENGINE',
      action: action === EngineAction.CUT ? 'engine_cut' : 'engine_restore',
      status,
      actor: source === 'SCHEDULER' ? 'planning' : 'utilisateur',
      target: vehicle?.plate ?? vehicle?.id ?? null,
      detail: reason ?? (action === EngineAction.CUT ? 'Coupure moteur' : 'Rétablissement moteur'),
      fleetId,
      triggeredByUserId: source === 'MANUAL' ? requestedBy.userId : null,
    });
  }

  /**
   * Sprint 3 (revue) — fabrique d'un refus `REJECTED_SPEED` : crée la commande, émet la
   * MAJ WS, loggue, puis lève. Factorise les 5 chemins de refus du bloc CUT (no-position,
   * stale, fix invalide, vitesse, règle veilleur). `throwMessage` peut différer du
   * `lastError` persisté (ex. message « stale » court côté HTTP vs détail en base).
   */
  private async rejectSpeed(
    params: {
      trackerId: string;
      action: EngineAction;
      reason: string | null;
      userId: string;
      source: 'MANUAL' | 'SCHEDULER';
    },
    fleetId: string,
    lastError: string,
    throwMessage: string = lastError,
  ): Promise<never> {
    const cmd = await this.prisma.engineControlCommand.create({
      data: {
        trackerId: params.trackerId,
        action: params.action,
        reason: params.reason,
        requestedBy: params.userId,
        source: params.source,
        status: CommandStatus.REJECTED_SPEED,
        lastError,
      },
    });
    this.emitUpdate(cmd, fleetId);
    this.logger.warn(`Command ${cmd.id} REJECTED: ${lastError}`);
    throw new ForbiddenException(throwMessage);
  }

  private async dispatchCommand(
    imei: string,
    command: EngineControlCommand,
    action: EngineAction,
    fleetId: string,
  ): Promise<void> {
    const cobanCmd: CobanCommand =
      action === EngineAction.CUT
        ? { type: 'engine_stop' }
        : { type: 'engine_resume' };

    const payload = encodeCommand(imei, cobanCmd);

    // Use registry.send() which checks socket.destroyed + has try-catch
    const sent = this.sessionRegistry.send(imei, payload);

    if (!sent) {
      // Fallback SMS : envoyer stop123456 / resume123456 au boitier via Twilio.
      const smsSent = await this.trySmsFallback(imei, action, command.id);
      if (smsSent.ok) {
        const updated = await this.prisma.engineControlCommand.update({
          where: { id: command.id },
          // TRK-018 — le ROUTAGE sort du champ d'erreur. `lastError` portait « Envoyé via
          // SMS (TCP indisponible) » : un champ dont le nom annonce une erreur et le contenu
          // livre une information de routage. Conséquence mesurée le 24/08 : un lecteur qui
          // trie sur `lastError IS NOT NULL` comptait 153 échecs qui n'en sont pas — le
          // défaut exact que TRK-007 dénonçait sur `outcomeReason`.
          //
          // ⚠️ `lastError` est mis à `null` ICI, sur les commandes NEUVES seulement : il n'y
          // a pas d'erreur, donc le champ doit être vide. Les lignes historiques gardent
          // leur texte (la migration rétro-remplit `channel` sans rien effacer) — détruire
          // une donnée pour corriger un nom serait pire que le nom.
          data: {
            status: CommandStatus.SENT,
            sentAt: new Date(),
            channel: 'SMS',
            lastError: null,
          },
        });
        this.emitUpdate(updated, fleetId);
        this.logger.log({ commandId: command.id, imei, channel: 'SMS' }, 'Command dispatched via SMS fallback');
        return;
      }

      const updated = await this.prisma.engineControlCommand.update({
        where: { id: command.id },
        data: {
          status: CommandStatus.FAILED,
          lastError: `Tracker hors ligne — socket TCP indisponible et repli SMS impossible : ${smsSent.reason}`,
        },
      });
      this.emitUpdate(updated, fleetId);
      this.errorLogger.record(
        `Commande moteur non transmise : boîtier hors ligne et repli SMS impossible (${smsSent.reason})`,
        'engine-control',
        { imei, commandId: command.id, smsFallbackReason: smsSent.reason },
      ).catch((e) => this.logger.error('ErrorLogger persist failed', e));
      throw new ServiceUnavailableException('Tracker hors ligne, commande non envoyée');
    }

    this.wireLogger.out(imei, payload, { commandId: command.id, source: 'engine' });
    this.logger.log({ commandId: command.id, imei, payload }, 'Command dispatched');

    const updated = await this.prisma.engineControlCommand.update({
      where: { id: command.id },
      // TRK-018 — le canal est écrit ICI aussi, pas seulement sur le repli. Ne le renseigner
      // que sur le chemin SMS aurait laissé `channel = NULL` sur le chemin nominal : on ne
      // saurait toujours pas distinguer « parti en TCP » de « on ne sait pas ».
      data: { status: CommandStatus.SENT, sentAt: new Date(), channel: 'TCP' },
    });
    this.emitUpdate(updated, fleetId);

    // Background ACK wait (fire-and-forget, same pattern as TrackerCommandsService)
    const ackPattern = action === EngineAction.CUT
      ? ENGINE_STOP_ACK_PATTERN
      : ENGINE_RESUME_ACK_PATTERN;

    this.ackWaiter
      .waitForAck(imei, ackPattern, ENGINE_ACK_TIMEOUT_MS, command.id, ENGINE_ACK_PRIORITY)
      .then(async (rawAck) => {
        const latencyMs = updated.sentAt
          ? Date.now() - new Date(updated.sentAt).getTime()
          : 0;
        this.wireLogger.ackMatch(imei, rawAck, command.id, latencyMs);
        try {
          const acked = await this.prisma.engineControlCommand.update({
            where: { id: command.id },
            data: { status: CommandStatus.ACKNOWLEDGED, ackedAt: new Date() },
          });
          this.emitUpdate(acked, fleetId);
        } catch (dbErr) {
          this.logger.error({ commandId: command.id, error: (dbErr as Error).message },
            'Failed to persist ACK status — command stuck as SENT');
          this.errorLogger.record(dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
            'engine-control', { imei, commandId: command.id, phase: 'ack-persist' },
          ).catch(() => {});
        }
        this.logger.log({ commandId: command.id, latencyMs }, 'Engine command ACK received');
      })
      .catch(() => {
        // V1.15 — Le Coban GPS403D EXECUTE les commandes moteur (J/K) silencieusement :
        // pas d'ACK applicatif fiable sur le fil (cf docs/03 §3.7.2). La seule preuve
        // d'execution est l'etat ignition de la trame de position suivante. Un timeout
        // d'attente d'echo n'est donc PAS un echec : la commande a bien ete livree au
        // boitier (ecriture socket OK). L'ancien code la passait FAILED + enregistrait
        // une fausse erreur "ACK timeout" dans le centre d'alertes a CHAQUE commande,
        // meme quand la coupure reussissait (cause des Erreurs #2/#3 du rapport). On la
        // laisse desormais en SENT (livree) ; le .then ci-dessus capte un eventuel echo
        // si un firmware en emet un. Amelioration future : confirmation via etat
        // ignition de la trame suivante (a valider terrain, cf docs/03 §11).
        this.logger.debug(
          { commandId: command.id, imei },
          'Engine command livree — pas d\'ACK applicatif attendu (execution silencieuse Coban)',
        );
      });

    // Sprint 2 (Obj 5) — sentinelle d'observabilité : une coupure CONFIRMABLE qui
    // n'est pas confirmée (chute d'ignition) dans la fenêtre est tracée au centre
    // d'alerte. PAS un FAILED (la commande a bien été livrée au boîtier) — juste de
    // la visibilité pour le suivi opérationnel / le debug.
    if (action === EngineAction.CUT && command.confirmationExpected) {
      const timer = setTimeout(() => {
        this.confirmTimers.delete(timer);
        // ⚠️ Un callback d'ARRIÈRE-PLAN ne doit JAMAIS pouvoir tuer le process. Sans ce `.catch`,
        // un rejet inattendu (Prisma fermé pendant un arrêt, ou un mock incomplet en test) devient
        // une « unhandled rejection » — que Node fait remonter en CRASH depuis la v15.
        // C'est exactement ce qui rendait la suite de tests instable (2026-07-20) : le timer se
        // réveillait pendant une AUTRE suite et emportait tout le worker avec lui.
        void this.reportIfUnconfirmed(command.id, imei).catch((e) =>
          this.logger.warn(`Sentinelle « coupure non confirmée » : ${(e as Error)?.message ?? e}`),
        );
      }, ENGINE_CONFIRM_WINDOW_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.confirmTimers.add(timer);
    }
  }

  /**
   * Sprint 2 (Obj 5) — trace une coupure confirmable restée non confirmée.
   *
   * ⚠️ La preuve attendue est une CHUTE D'IGNITION, lue sur les trames qui suivent l'envoi. Encore
   * faut-il qu'il en arrive : un boîtier qui a perdu son fix GPS reste joignable en TCP (donc la
   * commande PART) mais n'émet plus de position — aucune chute d'ignition ne peut alors être
   * observée, quoi qu'ait fait la coupure. Rapporter dans ce cas « pas de chute ignition » accuse
   * la coupure d'un échec qu'on n'a tout simplement pas pu mesurer.
   *
   * Constat prod (2026-07-27) : 7 alertes en 7 jours, une par jour à 20:00 pile, toujours le même
   * boîtier — muet en position depuis le 22/07 (`lastNoFixAt` frais, `lastPositionAt` figé). On
   * distingue donc les deux situations, et on nomme la vraie : le boîtier ne reporte plus.
   */
  private async reportIfUnconfirmed(commandId: string, imei: string): Promise<void> {
    const cmd = await this.prisma.engineControlCommand
      .findUnique({ where: { id: commandId }, select: { status: true, ackedAt: true, trackerId: true, sentAt: true } })
      .catch(() => null);
    if (!cmd || cmd.status !== CommandStatus.SENT || cmd.ackedAt) return;

    // A-t-on seulement REÇU quelque chose depuis l'envoi ? (`createdAt` = instant d'ingestion :
    // insensible à une horloge de boîtier décalée, contrairement à `timestamp`.)
    const since = cmd.sentAt ?? new Date(Date.now() - ENGINE_CONFIRM_WINDOW_MS);
    const framesSinceSend = await this.prisma.position
      .count({ where: { trackerId: cmd.trackerId, createdAt: { gte: since } } })
      .catch(() => null);
    const wentSilent = framesSinceSend === 0;

    const message = wentSilent
      ? 'Coupure moteur invérifiable : aucune position reçue depuis l\'envoi (boîtier sans fix GPS) — état réel du moteur inconnu'
      : 'Coupure moteur non confirmée (pas de chute ignition dans la fenêtre)';
    this.logger.warn({ commandId, imei, trackerId: cmd.trackerId, wentSilent }, message);

    // ── Perte de signal EXPLIQUÉE : on se tait ────────────────────────────────────
    // Un véhicule garé dans un parking souterrain n'a pas de fix GPS — c'est NORMAL, et
    // ça dure tant qu'il est garé. Répéter chaque soir « coupure invérifiable » pour un
    // fait connu et sans action possible, c'est le même travers que l'alerte de dormance
    // qu'on vient de retirer : un état stable ne se notifie pas en boucle.
    //
    // L'application sait déjà reconnaître ces endroits — `GpsDeadZone` avec le statut
    // CONFIRMED_BENIGN, qualifié par un opérateur, qui fait déjà taire le détecteur
    // « GPS perdu ». Cette sentinelle l'ignorait : confirmer une zone silenciait un canal
    // sur deux, et l'exploitant continuait de voir passer l'autre sans comprendre pourquoi.
    // Une seule confirmation doit produire un effet cohérent partout.
    //
    // Volontairement limité à `wentSilent` : si le boîtier PARLE et qu'on n'observe
    // simplement pas de chute d'ignition, la zone n'explique rien — l'alerte reste due.
    if (wentSilent && (await this.isInBenignDeadZone(cmd.trackerId))) {
      this.logger.log(
        { commandId, imei, trackerId: cmd.trackerId },
        'Coupure invérifiable NON remontée : le véhicule est dans une zone sans GPS confirmée (parking couvert)',
      );
      return;
    }

    this.errorLogger
      .record(message, 'engine-control', {
        commandId,
        imei,
        trackerId: cmd.trackerId,
        windowMs: ENGINE_CONFIRM_WINDOW_MS,
        framesSinceSend,
      })
      .catch((e) => this.logger.error('ErrorLogger persist failed', e));
  }

  /**
   * La dernière position connue du véhicule tombe-t-elle dans une zone sans GPS déclarée
   * BÉNIGNE par un opérateur (parking couvert habituel) ?
   *
   * Best-effort et FAIL-OPEN : si la question ne peut pas être tranchée (pas de position
   * connue, service indisponible), on répond `false` et l'alerte part. Mieux vaut une
   * alerte de trop qu'une coupure invérifiable passée sous silence par accident.
   */
  /**
   * TRK-046 — la dernière position valide (l'ancre, figée à l'ENTRÉE du lieu) tombe-t-elle
   * dans une zone parking VALIDÉE (souterrain/couvert) ? Même doctrine fail-open que
   * `isInBenignDeadZone` : dans le doute, on répond null et la coupe suit le chemin normal —
   * mieux vaut un report honnête de trop qu'une présomption de stationnement par accident.
   */
  private async zoneParkingValideePourAncre(
    vehicleId: string | null,
    lastLat: number | null,
    lastLng: number | null,
  ): Promise<{ label: GpsDeadZone['label']; placeLabel: string | null } | null> {
    try {
      if (!vehicleId || lastLat == null || lastLng == null) return null;
      const zone = await this.deadZones.matchZoneForPoint(vehicleId, lastLat, lastLng);
      return estZoneParkingValidee(zone) && zone ? zone : null;
    } catch {
      return null;
    }
  }

  private async isInBenignDeadZone(trackerId: string): Promise<boolean> {
    try {
      const tracker = await this.prisma.tracker.findUnique({
        where: { id: trackerId },
        select: { vehicleId: true, lastLat: true, lastLng: true },
      });
      if (!tracker?.vehicleId || tracker.lastLat == null || tracker.lastLng == null) return false;
      const zone = await this.deadZones.matchZoneForPoint(
        tracker.vehicleId,
        tracker.lastLat,
        tracker.lastLng,
      );
      return zone?.status === GpsDeadZoneStatus.CONFIRMED_BENIGN;
    } catch {
      return false;
    }
  }

  private emitUpdate(command: EngineControlCommand, fleetId: string): void {
    if (!fleetId) {
      this.logger.warn({ commandId: command.id }, 'emitUpdate skipped: no fleetId');
      return;
    }
    try {
      this.gateway.emitEngineCommandUpdate(fleetId, {
        commandId: command.id,
        trackerId: command.trackerId,
        action: command.action,
        status: command.status,
        lastError: command.lastError,
        confirmationExpected: command.confirmationExpected,
        sentAt: command.sentAt ? command.sentAt.toISOString() : null,
        ackedAt: command.ackedAt ? command.ackedAt.toISOString() : null,
        source: command.source as 'MANUAL' | 'SCHEDULER' | 'DEVICE_OBSERVED',
      });
    } catch (err) {
      this.logger.error({ commandId: command.id, fleetId, error: (err as Error).message },
        'WS emitUpdate failed — frontend may be out of sync');
    }
  }

  async listCommands(
    requestedBy: RequestedBy,
    filters?: { trackerId?: string; status?: CommandStatus; limit?: number },
  ): Promise<EngineControlCommand[]> {
    const limit = Math.min(filters?.limit ?? 50, 50);

    const where: Record<string, unknown> = {};

    // V1.16 (audit residual) — fail-closed : non-super sans fleetId => aucun resultat.
    const scope = resolveTenantScope(requestedBy);
    if (scope.mode === 'DENY') return [];
    if (scope.mode === 'FLEET') {
      where.tracker = { vehicle: { fleetId: scope.fleetId } };
    }

    if (filters?.trackerId) where.trackerId = filters.trackerId;
    if (filters?.status) where.status = filters.status;

    return this.prisma.engineControlCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Fallback SMS quand la socket TCP est indisponible.
   * Envoie `stop123456` (CUT) ou `resume123456` (RESTORE) au numero SIM du boitier.
   * Retourne true si le SMS a ete accepte par Twilio.
   */
  /**
   * Repli SMS du coupe-circuit. Renvoie la RAISON de l'échec, pas un simple booléen : trois
   * situations très différentes (passerelle éteinte / pas de numéro SIM / numéro REFUSÉ par la
   * passerelle) se confondaient en `false`, et l'appelant écrivait alors invariablement
   * « pas de simPhoneNumber » dans la commande.
   *
   * Constat prod (2026-07-25) : le repli échouait en réalité sur un 403 « hors allowlist » de
   * vizyo-texto, numéro SIM bien présent — l'opérateur lisait donc un diagnostic FAUX sur un
   * chemin de sécurité, et cherchait un numéro manquant qui ne manquait pas.
   */
  private async trySmsFallback(
    imei: string,
    action: EngineAction,
    commandId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.sms.isEnabled()) {
      return { ok: false, reason: 'passerelle SMS non configurée' };
    }
    const tracker = await this.prisma.tracker.findFirst({
      where: { imei },
      select: { simPhoneNumber: true },
    });
    if (!tracker?.simPhoneNumber) {
      return { ok: false, reason: 'aucun numéro SIM enregistré pour ce boîtier' };
    }
    const smsPayload = action === EngineAction.CUT ? 'stop123456' : 'resume123456';
    const result = await this.sms.send(tracker.simPhoneNumber, smsPayload, {
      imei,
      commandId,
      template: 'engine_control_fallback', source: 'engine-control-fallback',
    });
    if (result.ok) return { ok: true };
    return { ok: false, reason: result.error ?? 'envoi SMS refusé par la passerelle' };
  }

  async getCommand(id: string, requestedBy: RequestedBy): Promise<EngineControlCommand> {
    // V1.10 (Sprint 6) — IDOR fix : filtre tenant via la relation tracker.vehicle.
    const where: Prisma.EngineControlCommandWhereInput = { id };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Commande introuvable');
      where.tracker = { vehicle: { fleetId: requestedBy.fleetId } };
    }
    const command = await this.prisma.engineControlCommand.findFirst({
      where,
      include: { tracker: { include: { vehicle: true } } },
    });
    if (!command) {
      throw new NotFoundException('Commande introuvable');
    }
    return command;
  }
}
