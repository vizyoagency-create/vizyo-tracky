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
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
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
import { NIVEAU_DEGRADATION } from '../observability/niveaux-erreur';
import { COUPE_CIRCUIT_PUSH_EVENT, type CoupeCircuitPushEvent } from '../notifications/coupe-circuit-push.events';
import { resolveTenantScope } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SMS_INBOUND_EVENT, SmsGatewayService } from '../sms/sms-gateway.service';
import type { SmsInboundEvent } from '../sms/sms-gateway.service';
import {
  SocketRegistryService,
  TRACKER_CONNECTED_EVENT,
  type TrackerConnectedEvent,
} from '../socket-registry/socket-registry.service';
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
const ENGINE_ACK_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env['ENGINE_RESTORE_ACK_TIMEOUT_MS']) || 15_000,
);
const ENGINE_RESTORE_ALERT_AFTER_MS = Math.max(
  10_000,
  Number(process.env['ENGINE_RESTORE_ALERT_AFTER_MS']) || 60_000,
);
const ENGINE_RESTORE_MAX_SMS_ATTEMPTS = Math.max(
  1,
  Number(process.env['ENGINE_RESTORE_MAX_SMS_ATTEMPTS']) || 3,
);
const ENGINE_DISPATCH_LEASE_MS = 60_000;
/**
 * ══ CONTRE-EXPERTISE DU 13/09 (doc 19, P0-1) — UNE CLÉ D'UNICITÉ NE PEUT PAS VIVRE POUR TOUJOURS ══
 *
 * `activeKey` garantit une seule intention RESTORE active par boîtier. Elle n'était libérée que
 * par une PREUVE (ACK TCP, accusé SMS du boîtier, remontée d'ignition dans les 30 min) — preuve
 * qui n'arrive pas dans le cas nominal du repli SMS (2 accusés SMS en cinq semaines). Une RESTORE
 * partie par SMS, remise (`delivered`) et jamais acquittée gardait donc sa clé indéfiniment, et
 * TOUTE RESTORE suivante du même boîtier — planning du lendemain, clic manuel — était dédupliquée
 * vers elle : rien n'était envoyé, rien réarmé, aucune alerte neuve, et le cron avançait son état.
 * Mesuré sur 30 jours de production : au moins une RESTORE par SMS sans accusé presque chaque jour.
 *
 * Deux bornes, complémentaires :
 *   1. à la collision, une RESTORE `SENT` parquée (plus d'essai programmé), en attente lointaine
 *      ou silencieuse depuis ENGINE_RESTORE_REARM_AFTER_MS est RÉARMÉE — TCP d'abord, puis SMS —
 *      au lieu d'être rendue telle quelle (cf. `requestCommand`) ;
 *   2. passé ENGINE_RESTORE_EXPIRY_MS après le premier envoi, la ligne passe « envoyée, non
 *      confirmée » et libère la clé (cf. `cloturerCommandesPerimees`). Env
 *      `ENGINE_RESTORE_EXPIRY_MIN`, défaut 240 min — bien au-delà du polling du secours SMS.
 */
const ENGINE_RESTORE_EXPIRY_MS =
  Math.max(1, Number(process.env['ENGINE_RESTORE_EXPIRY_MIN']) || 240) *
  60 *
  1000;
const ENGINE_RESTORE_REARM_AFTER_MS = 10 * 60 * 1000;
/**
 * ══ T41 (contre-expertise du 13/09, P0-2) — UNE COUPURE PAR SMS A UNE DATE DE PÉREMPTION ═════
 *
 * Le 11/09, un SMS est resté 1 h 06 dans la file d'un téléphone endormi avant de partir. Une
 * COUPURE qui subit ce retard peut s'exécuter APRÈS la remise en route du matin : véhicule coupé
 * au départ, sans que personne ne l'ait demandé. Le relais transmet cette validité au serveur
 * capcom6 (`ttl`), et c'est le TÉLÉPHONE qui refuse d'émettre un message périmé — le seul endroit
 * où le retard se mesure. Env `ENGINE_CUT_SMS_TTL_S`, défaut 900 s, plancher 60 s. Une remise en
 * route, elle, ne périme jamais : elle part avec la priorité maximale (≥ 100 = hors limites et
 * délais du téléphone).
 */
const ENGINE_CUT_SMS_TTL_S = Math.max(
  60,
  Number(process.env['ENGINE_CUT_SMS_TTL_S']) || 900,
);
const ENGINE_RESTORE_SMS_PRIORITY = 100;
/**
 * ══ T42 (contre-expertise du 13/09, P1-1) — UNE RESTORE N'EST JAMAIS TERMINALE SANS PREUVE ═══
 *
 * Jusqu'ici : socket absente = un seul créneau de 15 s avant le secours SMS ; trois SMS refusés
 * = `FAILED`, clé libérée — et le cron des horaires, qui a déjà avancé son état, ne recrée jamais
 * l'intention. Un boîtier qui revenait en TCP à 07:40 ne recevait jamais K : seul un humain
 * rallumait. Les documents promettaient pourtant « jamais abandonnée, rejouée à la reconnexion »
 * (README du chantier, doc 03 §8, doc 07 R4.1, CC-003).
 *
 * Désormais :
 *   1. le registre de sockets émet `tracker.connected` ; la dernière RESTORE non prouvée du
 *      boîtier — plus récente que sa dernière CUT, créée depuis moins de 24 h — est RELANCÉE,
 *      TCP d'abord (`onTrackerConnected`). SANS budget SMS neuf : une reconnexion n'est pas une
 *      demande nouvelle (le budget neuf, c'est le réarmement P0-1 sur une demande neuve) ;
 *   2. le secours SMS épuisé ne ferme plus l'intention : elle reste `SENT`, garde sa clé, et K
 *      repart en TCP à chaque reconnexion et toutes les ENGINE_RESTORE_TCP_RETRY_MS — plus jamais
 *      un SMS de plus (`retryTcpOnly`). L'alerte CRITICAL, elle, part toujours ;
 *   3. une RESTORE ne transmet JAMAIS après une COUPURE plus récente qu'elle : le worker vérifie
 *      avant chaque envoi, et une CUT créée supplante les RESTORE encore ouvertes — l'intention
 *      la plus récente gagne, dans les deux sens ;
 *   4. l'échéance de 4 h (`cloturerCommandesPerimees`) borne le tout, y compris une intention
 *      qui n'a jamais rien transmis (`sentAt` nul → l'horloge part de `createdAt`).
 *
 * Env `ENGINE_RESTORE_TCP_RETRY_MIN`, défaut 30 min, plancher 1 min.
 */
const ENGINE_RESTORE_TCP_RETRY_MS =
  Math.max(1, Number(process.env['ENGINE_RESTORE_TCP_RETRY_MIN']) || 30) * 60 * 1000;
/** Même fenêtre que la preuve par ignition (positions.service) : au-delà, l'intention est morte. */
const ENGINE_RESTORE_RECONNECT_WINDOW_MS = 24 * 60 * 60 * 1000;
const ENGINE_RESTORE_SMS_EXHAUSTED_ALERT =
  'RESTORE : secours SMS épuisé — relance TCP seule à la reconnexion du boîtier, vérifier le véhicule';
const RESTORE_SUPPLANTEE_PAR_CUT = 'RESTORE supplantée par une intention CUT plus récente';
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

/**
 * ══ T49 (contre-expertise du 13/09, P2-2) — UNE COUPE RETENUE N'EST PAS UNE PANNE PAR VÉHICULE ══
 *
 * Le kill-switch et l'interlock écrivaient un CRITICAL à CHAQUE appel refusé. Le cron retente avec
 * un palier 2/5/15/30 min, la dédup d'ErrorLogger ne dure que 60 s, et la vigie envoie un
 * courriel par heure dès qu'un CRITICAL existe : un administrateur de flotte qui réactive lui-même
 * ses horaires (droit `schedules_manage`) déclenchait un flux nocturne de dizaines de lignes — et
 * autant de lignes « coupe impossible depuis N min » côté cron — sans connaître le kill-switch.
 *
 * Désormais :
 *   - le refus est une exception TYPÉE (`AutomaticCutWithheldException`, cause `kill-switch` ou
 *     `interlock`) : le cron la reconnaît par son type (jamais par son texte) et n'en fait pas un
 *     blocage à alerter — il retente avec son palier, sans écrire ;
 *   - le kill-switch est un ÉTAT VOULU, pas une faute : niveau DÉGRADATION (le niveau du centre
 *     d'alerte pour « repli propre, perte bornée, contrepartie acceptée » — TRK-037 ; il n'est
 *     pas compté comme une erreur et ne réveille pas la vigie), UNE ligne par heure au plus, qui
 *     compte les refus et nomme les véhicules concernés depuis la ligne précédente ;
 *   - l'interlock est une vraie panne de la chaîne de secours : CRITICAL, UNE ligne par raison et
 *     par quart d'heure, avec le même compte.
 *   Le compteur est en mémoire : un redémarrage coûte au pire une ligne de plus, jamais trente.
 */
export class AutomaticCutWithheldException extends ServiceUnavailableException {
  constructor(
    message: string,
    readonly cause: 'kill-switch' | 'interlock',
    readonly reason: string,
  ) {
    super(message);
  }
}
const ENGINE_KILL_SWITCH_ALERT_SPACING_MS = 60 * 60_000;
const ENGINE_INTERLOCK_ALERT_SPACING_MS = 15 * 60_000;
/** Plaques nommées dans une ligne : au-delà, on compte sans lister (une flotte fait 30 véhicules). */
const ENGINE_WITHHELD_MAX_PLATES = 40;
/**
 * ══ T48 (contre-expertise du 13/09, P2-1 · P2-4) — UNE PREUVE NE SE RÉTROGRADE PAS ══════════
 *
 * Les écritures « envoyée » (`status = SENT`) passaient par `update({ where: { id } })`, sans
 * garde : un ACK TCP arrivé pendant `trySmsFallback` (jusqu'à 10 s de file) ou une supplantation
 * survenue entre la création et le dispatch étaient ÉCRASÉS — commande `SENT` avec `ackedAt`
 * renseigné, écran « rallumage non confirmé » alors que le boîtier avait acquitté. Désormais ces
 * écritures sont CONDITIONNELLES (`ackedAt IS NULL`, statut encore ouvert) : si la condition ne
 * tient plus, la preuve reste, le SMS devenu inutile est annulé au relais (T41), et l'appelant
 * reçoit la ligne telle qu'elle est.
 *
 * Et une CUT créée puis jamais dispatchée (crash entre `create` et l'envoi) restait `PENDING`
 * avec sa clé d'unicité : la coupure antivol suivante rendait 201 avec cette vieille ligne et
 * n'envoyait RIEN. À la collision, une CUT `PENDING` plus vieille que le bail de dispatch est
 * désormais dispatchée — même logique que le réarmement RESTORE de P0-1.
 */
const ENGINE_ORPHAN_PENDING_AFTER_MS = ENGINE_DISPATCH_LEASE_MS;
/**
 * ══ T51 (contre-expertise du 13/09, P2-5 · P2-6) — UNE RESTORE QUI TRAÎNE SE RAPPELLE ══════
 *
 * La sentinelle alertait UNE fois (à 60 s) puis se taisait : un téléphone éteint pendant des
 * heures produisait une ligne, puis le silence, pendant que la RESTORE tournait en `queued`.
 * Désormais : une ligne toutes les ENGINE_RESTORE_REALERT_MS tant que l'intention n'est pas
 * prouvée ; et un SMS resté en file plus de ENGINE_RESTORE_SMS_STUCK_MS est annulé au relais
 * puis retenté (le budget SMS le compte — pas un SMS de plus qu'avant).
 *
 * Et le clic MANUEL ne reste plus suspendu derrière la file SMS : `requestCommand` répond au
 * plus tard après ENGINE_MANUAL_RESPONSE_BUDGET_MS avec l'intention persistée — le dispatch
 * finit en arrière-plan, l'écran est tenu au courant par le flux temps réel. Avant, N SMS en
 * file (15 s chacun) faisaient dépasser le délai du proxy : toast « refusé » pour une intention
 * pourtant enregistrée et suivie.
 */
const ENGINE_RESTORE_REALERT_MS = 15 * 60_000;
/**
 * Fenêtre au-delà de laquelle la sentinelle ne porte plus une RESTORE non prouvée : 24 h.
 * Mesuré au premier passage après le déploiement du 15/09 (17:35 UTC) : la migration avait
 * laissé `alertedAt` à NULL sur TOUT l'historique, et le balayage a réveillé une cinquantaine
 * de RESTORE `FAILED` de juillet-août (jamais acquittées, véhicules depuis longtemps repartis)
 * — une ligne CRITICAL, puis un rappel toutes les 15 min, pour toujours. Passé 24 h une RESTORE
 * n'est plus un geste de nuit à rattraper : l'audit quotidien la lit, la sentinelle se tait.
 */
const ENGINE_RESTORE_ALERT_WINDOW_MS = 24 * 60 * 60_000;
const ENGINE_RESTORE_SMS_STUCK_MS = 60 * 60_000;
/**
 * Push aux super-admins quand des coupes sont retenues : à l'ouverture de l'épisode (première
 * ligne par cause), puis une fois par heure tant qu'il dure. Le centre d'alerte garde ses lignes
 * toutes les 15 min ; le téléphone du propriétaire, lui, n'a pas à vibrer quatre fois par heure
 * pour une cause déjà connue.
 */
const ENGINE_WITHHELD_PUSH_SPACING_MS = 60 * 60_000;
/** Lu à chaque appel (pas au chargement) : les tests le règlent sans recharger le module. */
const manualResponseBudgetMs = (): number =>
  Math.max(1_000, Number(process.env['ENGINE_MANUAL_RESPONSE_BUDGET_MS']) || 20_000);

/**
 * ══ T62 (14/09/2026) — UNE SIM INJOIGNABLE PAR SMS MET LE VÉHICULE EN « TCP SEUL » ═══════════
 *
 * Mesuré le 14/09 : deux SIM de boîtiers (HD-584-BF, BP-434-RD) refusent tout SMS au départ
 * (`RESULT_ERROR_GENERIC_FAILURE`), à quelques secondes d'envois réussis vers leurs voisines,
 * boîtiers en ligne, SIM activées chez le fournisseur. Pour elles, le secours SMS n'existe pas ;
 * la seule voie de remise en route est le TCP. Le système doit le SAVOIR et en tirer trois
 * conséquences, plutôt que de le découvrir un matin à 07:00 :
 *
 *   1. une COUPURE automatique n'est émise que si le boîtier est vivant en TCP à cet instant
 *      (socket présente, trame récente) — sinon elle est reportée, comme pour un boîtier muet ;
 *   2. une RESTORE est relancée en TCP toutes les ENGINE_TCP_ONLY_RETRY_MS (5 min, pas 30) et
 *      à chaque reconnexion (T42), sans consommer de SMS ;
 *   3. un SMS-SONDE au plus toutes les ENGINE_SMS_PROBE_INTERVAL_MS (6 h) : si la voie SMS
 *      revient (c'est arrivé le 14/09 pour huit SIM), la série d'échecs se rompt et tout
 *      redevient normal. Coût borné : quatre SMS par jour et par véhicule bloqué, au pire.
 *
 * Le verdict vient de `sms_logs` : les ENGINE_SMS_UNREACHABLE_STREAK derniers sortants à issue
 * connue vers ce numéro sont tous `failed`. Les `queued` (issue inconnue) ne comptent pas.
 * Une ligne DÉGRADATION par véhicule et par jour dit « TCP seul » au centre d'alerte.
 */
const ENGINE_SMS_UNREACHABLE_STREAK = Math.max(
  2,
  Number(process.env['ENGINE_SMS_UNREACHABLE_STREAK']) || 3,
);
const ENGINE_SMS_REACHABILITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ENGINE_SMS_REACHABILITY_CACHE_MS = 60_000;
const ENGINE_SMS_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ENGINE_TCP_ONLY_RETRY_MS =
  Math.max(1, Number(process.env['ENGINE_TCP_ONLY_RETRY_MIN']) || 5) * 60 * 1000;
/** Une trame TCP de moins de 5 min ET une socket présente : le boîtier est joignable maintenant. */
const ENGINE_TCP_LIVE_MS = 5 * 60 * 1000;
const ENGINE_TCP_ONLY_ALERT_SPACING_MS = 24 * 60 * 60 * 1000;

export interface SmsReachability {
  /** Les N derniers sortants à issue connue ont tous échoué. */
  unreachable: boolean;
  /** Longueur de la série d'échecs consécutifs (0 si le dernier sortant connu est passé). */
  streak: number;
  lastFailureAt: Date | null;
}

@Injectable()
export class EngineControlService implements OnModuleDestroy {
  private readonly logger = new Logger(EngineControlService.name);
  private automaticCutHealthCache: { expiresAt: number; safe: boolean; reason: string } | null = null;
  private restoreWorkerRunning = false;
  /** T49 — par cause de refus : dernière ligne écrite, refus et véhicules accumulés depuis. */
  private readonly withheldCuts = new Map<
    string,
    { lastAt: number; refusals: number; vehicles: Set<string>; lastPushAt?: number }
  >();
  /** T62 — verdict de joignabilité SMS par numéro (60 s) et dernière ligne « TCP seul » par boîtier. */
  private readonly smsReachabilityCache = new Map<string, { expiresAt: number; verdict: SmsReachability }>();
  private readonly tcpOnlyAlertedAt = new Map<string, number>();

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
    private readonly events: EventEmitter2,
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
          // Une intention RESTORE ne doit jamais disparaître dans la clôture générique :
          // son worker dédié la suit jusqu'à ACK ou escalade humaine explicite.
          action: EngineAction.CUT,
          ackedAt: null,
          sentAt: { lt: echeance },
        },
        data: {
          status: CommandStatus.SENT_UNCONFIRMED,
          expiredAt: new Date(),
          activeKey: null,
          nextAttemptAt: null,
          dispatchLeaseUntil: null,
        },
      });
      if (count > 0) {
        this.logger.log(
          `TRK-018 : ${count} commande(s) moteur close(s) en SENT_UNCONFIRMED (échéance ${ENGINE_COMMAND_EXPIRY_MS / 60000} min).`,
        );
      }

      // Contre-expertise du 13/09 (P0-1) — la RESTORE n'est pas abandonnée par ce balayage
      // (son worker la suit, l'alerte à 60 s est déjà partie), mais sa clé d'unicité ne peut
      // pas survivre indéfiniment : au-delà de ENGINE_RESTORE_EXPIRY_MS après le premier envoi,
      // la ligne dit honnêtement « nul ne sait » et libère `activeKey`, pour qu'une nouvelle
      // demande crée une intention neuve au lieu d'être avalée. Une ligne sous lease (worker
      // en train de la traiter) est laissée au passage suivant : on ne réécrit jamais sous un
      // traitement en cours.
      const echeanceRestore = new Date(Date.now() - ENGINE_RESTORE_EXPIRY_MS);
      const restores = await this.prisma.engineControlCommand.updateMany({
        where: {
          status: CommandStatus.SENT,
          action: EngineAction.RESTORE,
          ackedAt: null,
          // T42 — une intention qui n'a JAMAIS rien transmis (socket absente, SMS refusés) n'a
          // pas de `sentAt` : son horloge part de sa création, sinon elle ne se fermerait jamais.
          AND: [
            {
              OR: [
                { sentAt: { lt: echeanceRestore } },
                { sentAt: null, createdAt: { lt: echeanceRestore } },
              ],
            },
            {
              OR: [
                { dispatchLeaseUntil: null },
                { dispatchLeaseUntil: { lt: new Date() } },
              ],
            },
          ],
        },
        data: {
          status: CommandStatus.SENT_UNCONFIRMED,
          expiredAt: new Date(),
          activeKey: null,
          nextAttemptAt: null,
          dispatchLeaseUntil: null,
        },
      });
      if (restores.count > 0) {
        this.logger.warn(
          `P0-1 : ${restores.count} RESTORE close(s) en SENT_UNCONFIRMED sans preuve (échéance ${ENGINE_RESTORE_EXPIRY_MS / 60000} min) — clé d'unicité libérée, véhicule à vérifier.`,
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
        data: {
          status: CommandStatus.ACKNOWLEDGED,
          ackedAt: new Date(),
          activeKey: null,
          nextAttemptAt: null,
          dispatchLeaseUntil: null,
        },
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

  /**
   * T42 — un boîtier vient de (re)devenir joignable en TCP : sa dernière RESTORE non prouvée
   * repart, TCP d'abord, sans attendre le prochain tick du worker.
   *
   * Périmètre volontairement étroit : la RESTORE la plus récente du boîtier, créée depuis moins
   * de 24 h, sans accusé, sans COUPURE demandée depuis (sinon la reconnexion raconte un autre
   * épisode et K rallumerait un véhicule qu'on vient de couper), et pas sous lease (le worker
   * écrit déjà sur cette socket). `FAILED` et `SENT_UNCONFIRMED` sont ravivées : c'est tout
   * l'objet — « nul ne sait » n'est pas « c'est fini ». Ne lève jamais : un abonné qui casse
   * casserait le login de TOUS les boîtiers.
   */
  @OnEvent(TRACKER_CONNECTED_EVENT)
  async onTrackerConnected(evt: TrackerConnectedEvent): Promise<void> {
    try {
      if (!evt?.imei) return;
      const restore = await this.prisma.engineControlCommand.findFirst({
        where: {
          tracker: { imei: evt.imei },
          action: EngineAction.RESTORE,
          source: { not: 'DEVICE_OBSERVED' },
          createdAt: { gte: new Date(Date.now() - ENGINE_RESTORE_RECONNECT_WINDOW_MS) },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!restore || restore.ackedAt || restore.status === CommandStatus.ACKNOWLEDGED) return;
      if (restore.dispatchLeaseUntil && restore.dispatchLeaseUntil.getTime() > Date.now()) return;
      if (await this.restoreSupplanteeParCut(restore)) return;

      const rearmed = await this.rearmRestoreOnReconnect(restore, evt);
      if (!rearmed) return;
      // La socket est là MAINTENANT : on ne laisse pas passer jusqu'à 15 s de tick.
      void this.processPendingRestores().catch((err) =>
        this.logger.warn(
          { imei: evt.imei, error: err instanceof Error ? err.message : String(err) },
          'Worker RESTORE non relancé après reconnexion — le tick suivant reprendra',
        ),
      );
    } catch (err) {
      this.logger.warn(
        { imei: evt?.imei, error: err instanceof Error ? err.message : String(err) },
        'Relance RESTORE à la reconnexion impossible (T42)',
      );
    }
  }

  /**
   * T42 — une COUPURE demandée après cette RESTORE la rend obsolète : l'intention la plus
   * récente gagne. Les refus (REJECTED_SPEED) et les observations boîtier ne comptent pas.
   */
  private async restoreSupplanteeParCut(
    restore: Pick<EngineControlCommand, 'trackerId' | 'createdAt'>,
  ): Promise<boolean> {
    const cutSince = await this.prisma.engineControlCommand.findFirst({
      where: {
        trackerId: restore.trackerId,
        action: EngineAction.CUT,
        source: { not: 'DEVICE_OBSERVED' },
        status: { not: CommandStatus.REJECTED_SPEED },
        createdAt: { gt: restore.createdAt },
      },
      select: { id: true },
    });
    // `!= null` et non `!== null` : une lecture douteuse ne doit pas bloquer une remise en route —
    // le sens sûr d'une RESTORE est d'être transmise.
    return cutSince != null;
  }

  private async rearmRestoreOnReconnect(
    restore: EngineControlCommand,
    evt: TrackerConnectedEvent,
  ): Promise<boolean> {
    const now = new Date();
    try {
      // `updateMany` conditionnel : un ACK arrivé entre la relecture et ici l'emporte. Le budget
      // SMS (`smsAttemptCount`) n'est PAS remis à zéro — voir l'en-tête T42.
      const { count } = await this.prisma.engineControlCommand.updateMany({
        where: {
          id: restore.id,
          ackedAt: null,
          status: {
            in: [
              CommandStatus.PENDING,
              CommandStatus.SENT,
              CommandStatus.FAILED,
              CommandStatus.SENT_UNCONFIRMED,
            ],
          },
        },
        data: {
          status: CommandStatus.PENDING,
          channel: null,
          smsLogId: null,
          expiredAt: null,
          activeKey: `${restore.trackerId}:${EngineAction.RESTORE}`,
          nextAttemptAt: now,
          dispatchLeaseUntil: null,
          lastError: `Boîtier reconnecté en TCP (${evt.remoteAddress}) — RESTORE relancée, TCP d’abord`,
        },
      });
      if (count !== 1) return false;
      this.logger.warn(
        {
          commandId: restore.id,
          trackerId: restore.trackerId,
          imei: evt.imei,
          previousStatus: restore.status,
          smsAttemptCount: (restore as EngineControlCommand & { smsAttemptCount?: number }).smsAttemptCount ?? 0,
          ageMs: now.getTime() - restore.createdAt.getTime(),
          replaced: evt.replaced,
        },
        'RESTORE non prouvée relancée à la reconnexion du boîtier (T42)',
      );
      return true;
    } catch (err) {
      // Une autre RESTORE porte déjà la clé d'unicité (course avec une demande neuve) : celle-là
      // est en cours, on ne ravive pas la vieille.
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.debug({ commandId: restore.id }, 'Relance à la reconnexion écartée : une autre RESTORE est active');
        return false;
      }
      throw err;
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
    idempotencyKey?: string,
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

    // Kill-switch fail-closed : en production, une variable absente ou mal
    // orthographiée BLOQUE les coupures automatiques. RESTORE et actions manuelles
    // restent disponibles. La réactivation est une décision Go explicite.
    if (
      source === 'SCHEDULER' &&
      action === EngineAction.CUT &&
      process.env['NODE_ENV'] === 'production' &&
      process.env['ENGINE_AUTOMATIC_CUT_ENABLED'] !== 'true'
    ) {
      const reason = 'ENGINE_AUTOMATIC_CUT_ENABLED ≠ true';
      await this.signalWithheldCut('kill-switch', reason, {
        trackerId,
        imei: tracker.imei,
        fleetId,
        plate: tracker.vehicle.plate ?? null,
      });
      throw new AutomaticCutWithheldException(
        'Coupures automatiques désactivées par le garde-fou de fiabilité',
        'kill-switch',
        reason,
      );
    }
    if (
      source === 'SCHEDULER' &&
      action === EngineAction.CUT &&
      process.env['NODE_ENV'] === 'production'
    ) {
      await this.assertAutomaticCutSafe(trackerId, tracker.imei, fleetId, tracker.vehicle.plate);
    }

    // Un retry HTTP portant la même clé converge immédiatement vers l'intention
    // existante. Le filtre tenant a déjà été appliqué au tracker ci-dessus.
    if (idempotencyKey) {
      const replay = await this.prisma.engineControlCommand.findFirst({
        where: { idempotencyKey, trackerId },
      });
      if (replay) {
        if (replay.action !== action) {
          throw new ConflictException('Clé de commande déjà utilisée pour une autre action');
        }
        return replay;
      }
    }

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
      // T62 — SIM injoignable par SMS : on ne coupe que si le TCP est vivant MAINTENANT, parce
      // que la remise en route n'aura que lui. Sinon report (même palier que « boîtier muet »).
      await this.assertTcpOnlyCutSafe({ ...tracker, vehicle: tracker.vehicle });
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
        // Défense en profondeur : l'option durable n'a de sens que pour CUT. Le contrôleur HTTP
        // rejette déjà RESTORE + disableSchedule, mais aucun appel interne ne doit pouvoir sortir
        // silencieusement un véhicule du planning en le rallumant.
        const mayDisableSchedule = disableSchedule && action === EngineAction.CUT && !isWatchman;
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

    const activeKey = `${trackerId}:${action}`;
    if (action === EngineAction.RESTORE) {
      // Un ordre de sécurité RESTORE rend toute CUT encore en vol obsolète. Un
      // ACK tardif de cette CUT ne devra plus refaire croire que le véhicule est
      // coupé ; l'état explicite conserve néanmoins la trace de l'incertitude.
      //
      // T41 — supplanter en base ne suffit pas : une CUT partie par SMS peut encore attendre
      // dans la file du téléphone (ou du relais), et partirait APRÈS ce rallumage. On relit
      // donc les CUT visées AVANT de les clore, pour demander au relais l'annulation de leur
      // SMS — best-effort, sans retarder la création de l'intention RESTORE.
      const supplantees = await this.prisma.engineControlCommand.findMany({
        where: {
          trackerId,
          action: EngineAction.CUT,
          status: { in: [CommandStatus.PENDING, CommandStatus.SENT] },
          activeKey: { not: null },
        },
        select: { id: true, smsLogId: true, channel: true },
      });
      await this.prisma.engineControlCommand.updateMany({
        where: {
          trackerId,
          action: EngineAction.CUT,
          status: { in: [CommandStatus.PENDING, CommandStatus.SENT] },
          activeKey: { not: null },
        },
        data: {
          status: CommandStatus.SENT_UNCONFIRMED,
          activeKey: null,
          nextAttemptAt: null,
          dispatchLeaseUntil: null,
          expiredAt: new Date(),
          lastError: 'CUT supplantée par une intention RESTORE plus récente',
        },
      });
      for (const cut of supplantees) {
        if (!cut.smsLogId) continue;
        void this.cancelSupersededCutSms(cut.id, cut.smsLogId, tracker.imei);
      }
    }
    let command: EngineControlCommand;
    try {
      command = await this.prisma.engineControlCommand.create({
        data: {
          trackerId,
          action,
          reason,
          requestedBy: requestedBy.userId,
          source,
          status: CommandStatus.PENDING,
          confirmationExpected,
          idempotencyKey: idempotencyKey ?? null,
          activeKey,
          nextAttemptAt: new Date(),
        },
      });
    } catch (err) {
      // La contrainte unique est l'arbitre réel des clics concurrents entre
      // plusieurs instances API. Une collision renvoie l'intention déjà active.
      if ((err as { code?: string })?.code !== 'P2002') throw err;
      // Ne jamais relire une commande d'un autre boîtier : idempotencyKey est
      // globalement unique et peut être fournie par le client. Une collision
      // inter-véhicule ne doit donc ni divulguer ni réutiliser cette commande.
      if (idempotencyKey) {
        const replay = await this.prisma.engineControlCommand.findFirst({
          where: { idempotencyKey, trackerId },
        });
        if (replay?.trackerId === trackerId) {
          if (replay.action !== action) {
            throw new ConflictException('Clé de commande déjà utilisée pour une autre action');
          }
          return replay;
        }
      }

      const active = await this.prisma.engineControlCommand.findFirst({
        where: { activeKey, trackerId },
        orderBy: { createdAt: 'desc' },
      });
      if (active?.trackerId !== trackerId) {
        throw new ConflictException('Clé de commande déjà utilisée');
      }
      // Contre-expertise du 13/09 (P0-1) : une RESTORE active n'est rendue telle quelle que si
      // elle est réellement en cours de traitement. Parquée, en attente lointaine ou muette,
      // elle est RÉARMÉE et repart par le dispatch ci-dessous — sinon la demande neuve serait
      // avalée sans qu'un seul octet ne parte vers le boîtier.
      const rearmed = await this.rearmStaleRestore(active);
      if (rearmed) {
        command = rearmed;
      } else if (this.isOrphanPending(active)) {
        // T48 — une intention créée puis jamais transmise (crash entre create et dispatch) :
        // on la dispatche au lieu de la rendre telle quelle. La clé reste la sienne.
        this.logger.warn(
          { commandId: active.id, trackerId, action, ageMs: Date.now() - active.createdAt.getTime() },
          'Intention PENDING orpheline dispatchée à la collision (T48)',
        );
        command = active;
      } else {
        return active;
      }
    }

    if (action === EngineAction.CUT && command.status === CommandStatus.PENDING) {
      // T42 — symétrique de la supplantation ci-dessus : une COUPURE neuve rend obsolète toute
      // RESTORE encore ouverte du boîtier. Sans cela, une RESTORE relancée en TCP (reconnexion,
      // créneau de 30 min) pourrait renvoyer K APRÈS le J du soir. La ligne garde sa trace en
      // « nul ne sait » ; elle ne transmettra plus rien (le worker revérifie de son côté).
      await this.prisma.engineControlCommand
        .updateMany({
          where: {
            trackerId,
            action: EngineAction.RESTORE,
            status: { in: [CommandStatus.PENDING, CommandStatus.SENT] },
            ackedAt: null,
            activeKey: { not: null },
            id: { not: command.id },
          },
          data: {
            status: CommandStatus.SENT_UNCONFIRMED,
            activeKey: null,
            nextAttemptAt: null,
            dispatchLeaseUntil: null,
            expiredAt: new Date(),
            lastError: RESTORE_SUPPLANTEE_PAR_CUT,
          },
        })
        .catch((err) =>
          this.logger.warn(
            { trackerId, error: err instanceof Error ? err.message : String(err) },
            'Supplantation des RESTORE ouvertes par la CUT impossible — le worker revérifiera avant tout envoi',
          ),
        );
    }

    if (command.status === CommandStatus.PENDING) {
      // Palier B — journalise la commande moteur (arrière-plan / device). SUCCESS = commande
      // livrée (TCP ou SMS) ; FAILURE = dispatch impossible. L'ACK/confirmation détaillé reste
      // dans l'onglet « Commandes moteur ». Les refus (REJECTED_SPEED) lèvent avant ce point.
      try {
        command = await this.dispatchBounded(tracker.imei, command, action, fleetId, source);
        // Une intention RESTORE conservée en base mais pas encore transmise n'est pas un
        // « succès ». SKIPPED signifie ici « en attente/reprise automatique » ; les détails
        // de transport et l'ACK restent portés par EngineControlCommand.
        this.recordSystemActivity(
          action,
          tracker.vehicle,
          reason,
          requestedBy,
          source,
          fleetId,
          command.status === CommandStatus.PENDING ? 'SKIPPED' : 'SUCCESS',
        );
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
    status: 'SUCCESS' | 'FAILURE' | 'SKIPPED',
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

  /**
   * ══ CONTRE-EXPERTISE DU 13/09 (doc 19, P0-1) — LA DEMANDE NEUVE EST UN ORDRE ══════════════
   *
   * Une RESTORE active retrouvée à la collision n'est rendue telle quelle QUE si elle est
   * réellement en train d'être traitée : essai programmé dans la fenêtre du worker et activité
   * récente — c'est le double clic, ou le planning qui repasse pendant qu'un opérateur vient de
   * cliquer. Dans tous les autres cas, la commande dort :
   *   - PARQUÉE : plus aucun essai programmé (le worker a lu « SMS remis » et s'est arrêté là,
   *     sans preuve boîtier) — le cas mesuré presque chaque jour en production ;
   *   - LOINTAINE : prochain essai au-delà de la fenêtre d'ACK (backoff SMS) alors qu'un humain
   *     ou le planning demande le rallumage maintenant ;
   *   - MUETTE : aucune activité depuis ENGINE_RESTORE_REARM_AFTER_MS (worker mort, ligne
   *     d'hier).
   * On la réarme alors : retour en PENDING, canal effacé (TCP d'abord, secours SMS ensuite),
   * budget SMS neuf, lease posé pour que le worker laisse passer le dispatch immédiat de
   * `requestCommand`. Une RESTORE est idempotente : la renvoyer ne coûte au pire qu'un SMS,
   * ne pas la renvoyer coûte un véhicule immobilisé.
   *
   * ⚠️ `sentAt` est remis à null : c'est l'instant du PREMIER envoi de l'intention courante, et
   * l'échéance de `cloturerCommandesPerimees` se lit dessus — une valeur d'hier ferait clore la
   * nouvelle tentative au balayage suivant. `alertedAt` est laissé tel quel : l'alerte « non
   * confirmé depuis 60 s » a déjà été portée pour cette intention, et un échec terminal de la
   * nouvelle tentative écrit la sienne.
   *
   * Rend `null` si rien n'a été réarmé (commande non éligible, ou modifiée entre-temps par
   * l'ACK ou le worker — `updateMany` conditionnel).
   */
  /**
   * T41 — demande au relais l'annulation du SMS d'une CUT supplantée, et le dit sur la commande.
   * Ne lève jamais : un refus (message déjà pris par le téléphone, relais ancien) est journalisé
   * et laisse la commande en `SENT_UNCONFIRMED` — l'état qui dit honnêtement « nul ne sait ».
   */
  private async cancelSupersededCutSms(
    commandId: string,
    smsLogId: string,
    imei: string,
  ): Promise<void> {
    try {
      const result = await this.sms.cancelOutbound(smsLogId);
      if (result.ok) {
        await this.prisma.engineControlCommand
          .updateMany({
            where: { id: commandId, status: CommandStatus.SENT_UNCONFIRMED },
            data: {
              lastError:
                'CUT supplantée par une intention RESTORE plus récente — SMS annulé au relais avant émission',
            },
          })
          .catch(() => undefined);
        this.logger.log(
          { commandId, smsLogId, imei, status: result.status },
          'SMS de CUT supplantée annulé au relais (T41)',
        );
        return;
      }
      this.logger.warn(
        { commandId, smsLogId, imei, reason: result.reason },
        'SMS de CUT supplantée NON annulé — la validité (ttl) posée à l’envoi reste la seule garde',
      );
    } catch (err) {
      this.logger.warn(
        { commandId, smsLogId, error: err instanceof Error ? err.message : String(err) },
        'Annulation du SMS de CUT supplantée impossible',
      );
    }
  }

  /**
   * T51 — un clic MANUEL attend le dispatch au plus ENGINE_MANUAL_RESPONSE_BUDGET_MS ; au-delà,
   * l'intention persistée est rendue telle quelle (PENDING, suivie par le worker et le flux
   * temps réel) pendant que l'envoi finit en arrière-plan. Le planificateur, lui, attend : rien
   * ne presse un cron, et son état ne doit avancer qu'une fois la commande réellement partie.
   */
  private async dispatchBounded(
    imei: string,
    command: EngineControlCommand,
    action: EngineAction,
    fleetId: string,
    source: 'MANUAL' | 'SCHEDULER',
  ): Promise<EngineControlCommand> {
    const dispatched = this.dispatchCommand(imei, command, action, fleetId, false, source);
    if (source !== 'MANUAL') return dispatched;

    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), manualResponseBudgetMs());
      timer.unref?.();
    });
    try {
      const first = await Promise.race([dispatched, budget]);
      if (first) return first;
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Le budget est écoulé : le dispatch continue seul. Ses erreurs sont déjà journalisées par
    // dispatchCommand (FAILED + centre d'alerte) ; ici on empêche seulement un rejet orphelin.
    dispatched
      .then((done) =>
        this.logger.log(
          { commandId: command.id, imei, status: done.status, channel: done.channel },
          'Dispatch manuel terminé en arrière-plan après le budget de réponse (T51)',
        ),
      )
      .catch((err) =>
        this.logger.warn(
          { commandId: command.id, imei, error: err instanceof Error ? err.message : String(err) },
          'Dispatch manuel terminé en échec en arrière-plan (T51) — déjà remonté au centre d’alerte',
        ),
      );
    this.logger.warn(
      { commandId: command.id, imei, action, budgetMs: manualResponseBudgetMs() },
      'Réponse rendue avant la fin du dispatch : intention persistée, envoi en cours (T51)',
    );
    return command;
  }

  /**
   * T62 — les N derniers sortants à issue connue vers ce numéro ont-ils tous échoué ?
   * `queued` (issue inconnue) est ignoré ; `sent`, `delivered`, `received` rompent la série.
   * Sans numéro : joignable par défaut (l'envoi échouera de lui-même, comme avant). Ne lève
   * jamais : une base illisible rend « joignable » — le silence n'est pas un défaut sûr ici,
   * mais bloquer toutes les coupes sur une panne de lecture ne l'est pas non plus.
   */
  async smsReachability(toNumber: string | null): Promise<SmsReachability> {
    const joignable: SmsReachability = { unreachable: false, streak: 0, lastFailureAt: null };
    if (!toNumber) return joignable;
    const cached = this.smsReachabilityCache.get(toNumber);
    if (cached && cached.expiresAt > Date.now()) return cached.verdict;
    try {
      const rows = await this.prisma.smsLog.findMany({
        where: {
          direction: 'OUT',
          toNumber,
          createdAt: { gte: new Date(Date.now() - ENGINE_SMS_REACHABILITY_WINDOW_MS) },
          status: { in: ['failed', 'undelivered', 'sent', 'delivered', 'received'] },
        },
        orderBy: { createdAt: 'desc' },
        take: ENGINE_SMS_UNREACHABLE_STREAK,
        select: { status: true, createdAt: true },
      });
      let streak = 0;
      for (const r of rows) {
        if (r.status === 'failed' || r.status === 'undelivered') streak += 1;
        else break;
      }
      const verdict: SmsReachability = {
        unreachable: rows.length >= ENGINE_SMS_UNREACHABLE_STREAK && streak >= ENGINE_SMS_UNREACHABLE_STREAK,
        streak,
        lastFailureAt: rows[0] && (rows[0].status === 'failed' || rows[0].status === 'undelivered') ? rows[0].createdAt : null,
      };
      this.smsReachabilityCache.set(toNumber, { expiresAt: Date.now() + ENGINE_SMS_REACHABILITY_CACHE_MS, verdict });
      return verdict;
    } catch (err) {
      this.logger.warn(
        { toNumber, error: err instanceof Error ? err.message : String(err) },
        'Joignabilité SMS illisible — considérée joignable (T62)',
      );
      return joignable;
    }
  }

  /** T62 — une sonde SMS est due quand le dernier échec date de plus de ENGINE_SMS_PROBE_INTERVAL_MS. */
  private smsProbeDue(reach: SmsReachability): boolean {
    if (!reach.lastFailureAt) return true;
    return Date.now() - reach.lastFailureAt.getTime() >= ENGINE_SMS_PROBE_INTERVAL_MS;
  }

  /**
   * T62 — coupe automatique sur une SIM injoignable par SMS : seulement si le boîtier est vivant
   * en TCP maintenant (socket présente ET trame de moins de ENGINE_TCP_LIVE_MS). Sinon report.
   */
  private async assertTcpOnlyCutSafe(
    tracker: { id: string; imei: string; simPhoneNumber: string | null; lastSeenAt: Date | null; vehicle: { id: string; fleetId: string; plate: string | null } },
  ): Promise<void> {
    const reach = await this.smsReachability(tracker.simPhoneNumber);
    if (!reach.unreachable) return;
    await this.signalTcpOnly(tracker, reach);
    const silentMs = trackerSilenceMs(tracker.lastSeenAt);
    const live = this.sessionRegistry.get(tracker.imei) !== undefined && silentMs != null && silentMs <= ENGINE_TCP_LIVE_MS;
    if (live) return;
    throw new ForbiddenException(
      `Coupe auto suspendue : SIM injoignable par SMS (${reach.streak} échecs consécutifs) et boîtier hors TCP — véhicule en TCP seul, la coupe partira quand il sera connecté`,
    );
  }

  /** T62 — une ligne DÉGRADATION par boîtier et par jour : « ce véhicule est en TCP seul ». */
  private async signalTcpOnly(
    tracker: { id: string; imei: string; simPhoneNumber: string | null; vehicle: { id: string; fleetId: string; plate: string | null } },
    reach: SmsReachability,
  ): Promise<void> {
    const last = this.tcpOnlyAlertedAt.get(tracker.id) ?? 0;
    if (Date.now() - last < ENGINE_TCP_ONLY_ALERT_SPACING_MS) return;
    this.tcpOnlyAlertedAt.set(tracker.id, Date.now());
    await this.errorLogger.record(
      `Véhicule ${tracker.vehicle.plate ?? tracker.imei} en TCP seul : sa SIM est injoignable par SMS (${reach.streak} échecs consécutifs, dernier ${reach.lastFailureAt?.toISOString() ?? 'inconnu'}). ` +
        'La coupe automatique n’est émise que boîtier connecté ; la remise en route repart en TCP toutes les 5 min et à chaque reconnexion ; un SMS-sonde par 6 h. ' +
        'À traiter : test depuis un autre opérateur, ticket WhereverSIM, ou remplacement de la SIM.',
      'engine-control-tcp-only',
      {
        trackerId: tracker.id,
        imei: tracker.imei,
        fleetId: tracker.vehicle.fleetId,
        vehicleId: tracker.vehicle.id,
        plate: tracker.vehicle.plate ?? undefined,
        toNumber: tracker.simPhoneNumber ?? undefined,
        streak: reach.streak,
        lastFailureAt: reach.lastFailureAt?.toISOString() ?? null,
      },
      NIVEAU_DEGRADATION,
    ).catch(() => undefined);
  }

  /** T48 — PENDING, hors bail, plus vieille que le bail : personne ne la dispatche plus. */
  private isOrphanPending(command: EngineControlCommand): boolean {
    if (command.status !== CommandStatus.PENDING || command.ackedAt) return false;
    const now = Date.now();
    if (command.dispatchLeaseUntil && command.dispatchLeaseUntil.getTime() > now) return false;
    return now - command.createdAt.getTime() > ENGINE_ORPHAN_PENDING_AFTER_MS;
  }

  /**
   * T48 — écrit « envoyée » SANS jamais écraser une preuve : la condition (`ackedAt IS NULL`,
   * statut encore ouvert) voyage dans l'instruction elle-même. Quand elle ne tient plus, la
   * ligne est relue et rendue telle qu'elle est ; si un SMS venait d'être accepté pour rien,
   * il est annulé au relais (best-effort, T41).
   */
  private async writeSent(
    command: EngineControlCommand,
    data: Prisma.EngineControlCommandUpdateInput,
    options: { imei: string; redundantSmsLogId?: string | null },
  ): Promise<{ row: EngineControlCommand; written: boolean }> {
    const { count } = await this.prisma.engineControlCommand.updateMany({
      where: {
        id: command.id,
        ackedAt: null,
        status: { in: [CommandStatus.PENDING, CommandStatus.SENT] },
      },
      data,
    });
    let reloaded: EngineControlCommand | null = null;
    try {
      reloaded = (await this.prisma.engineControlCommand.findUnique({ where: { id: command.id } })) ?? null;
    } catch {
      reloaded = null;
    }
    if (count === 1) {
      return { row: reloaded ?? ({ ...command, ...(data as Partial<EngineControlCommand>) } as EngineControlCommand), written: true };
    }
    this.logger.warn(
      { commandId: command.id, imei: options.imei, status: reloaded?.status, ackedAt: reloaded?.ackedAt ?? null },
      'Écriture « envoyée » écartée : la commande a été acquittée ou supplantée entre-temps (T48)',
    );
    if (options.redundantSmsLogId) {
      void this.sms
        .cancelOutbound(options.redundantSmsLogId)
        .then((r) =>
          this.logger.log(
            { commandId: command.id, smsLogId: options.redundantSmsLogId, ok: r.ok, reason: r.reason },
            'SMS devenu inutile après acquittement : annulation demandée au relais',
          ),
        )
        .catch(() => undefined);
    }
    return { row: reloaded ?? command, written: false };
  }

  private async rearmStaleRestore(
    active: EngineControlCommand,
  ): Promise<EngineControlCommand | null> {
    if (active.action !== EngineAction.RESTORE) return null;
    if (active.status !== CommandStatus.SENT || active.ackedAt) return null;
    const now = Date.now();
    const lastActivity = (
      active.lastAttemptAt ??
      active.sentAt ??
      active.createdAt
    ).getTime();
    const parked = active.nextAttemptAt == null;
    const farAway =
      active.nextAttemptAt != null &&
      active.nextAttemptAt.getTime() > now + ENGINE_ACK_TIMEOUT_MS;
    const silent = now - lastActivity > ENGINE_RESTORE_REARM_AFTER_MS;
    if (!parked && !farAway && !silent) return null;

    const leaseUntil = new Date(now + ENGINE_DISPATCH_LEASE_MS);
    const data = {
      status: CommandStatus.PENDING,
      channel: null,
      smsLogId: null,
      smsAttemptCount: 0,
      sentAt: null,
      nextAttemptAt: new Date(now),
      dispatchLeaseUntil: leaseUntil,
      lastError:
        'Intention RESTORE réarmée par une nouvelle demande — TCP d’abord, puis secours SMS',
    };
    const { count } = await this.prisma.engineControlCommand.updateMany({
      where: { id: active.id, status: CommandStatus.SENT, ackedAt: null },
      data,
    });
    if (count !== 1) return null;
    this.logger.warn(
      {
        commandId: active.id,
        trackerId: active.trackerId,
        parked,
        farAway,
        silent,
        ageMs: now - active.createdAt.getTime(),
      },
      'RESTORE active réarmée au lieu d’être rendue telle quelle (P0-1)',
    );
    const reloaded = await this.prisma.engineControlCommand
      .findUnique({ where: { id: active.id } })
      .catch(() => null);
    return reloaded ?? { ...active, ...data };
  }

  private attemptDelegate(): {
    create(args: unknown): Promise<{ id: string }>;
    updateMany(args: unknown): Promise<{ count: number }>;
  } | undefined {
    return (this.prisma as unknown as {
      engineDeliveryAttempt?: {
        create(args: unknown): Promise<{ id: string }>;
        updateMany(args: unknown): Promise<{ count: number }>;
      };
    }).engineDeliveryAttempt;
  }

  /** Deuxième étage fail-closed, évalué seulement quand le kill-switch est armé. */
  private async assertAutomaticCutSafe(trackerId: string, imei: string, fleetId: string, plate?: string | null): Promise<void> {
    const now = Date.now();
    if (!this.automaticCutHealthCache || this.automaticCutHealthCache.expiresAt <= now) {
      try {
        const health = await this.sms.healthCheck();
        const queue = this.sms.dispatchQueueState();
        const terminalAgeMs = health.lastTerminalSuccessAt
          ? now - new Date(health.lastTerminalSuccessAt).getTime()
          : Number.POSITIVE_INFINITY;
        const freshProof = terminalAgeMs <= 24 * 60 * 60 * 1000;
        const gatewayOperational =
          this.sms.currentProvider() !== 'vizyo-texto' ||
          health.gateway?.operational === true;
        const safe =
          health.enabled &&
          health.reachable &&
          gatewayOperational &&
          health.deliveryProofAvailable &&
          freshProof &&
          queue.depth < 10;
        const reason = safe
          ? 'ok'
          : !health.enabled
            ? 'passerelle SMS désactivée'
            : !health.reachable
              ? `relais SMS injoignable${health.error ? ` : ${health.error}` : ''}`
              : !gatewayOperational
                ? `téléphone Android/SIM indisponible${health.error ? ` : ${health.error}` : ''}`
                : !health.deliveryProofAvailable
                  ? 'aucune preuve de remise SMS disponible'
                  : !freshProof
                    ? 'dernière preuve de remise SMS trop ancienne (> 24 h)'
                    : `file SMS trop profonde (${queue.depth})`;
        this.automaticCutHealthCache = {
          expiresAt: now + 30_000,
          safe,
          reason,
        };
      } catch (err) {
        this.automaticCutHealthCache = {
          expiresAt: now + 10_000,
          safe: false,
          reason: `contrôle de santé impossible : ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (this.automaticCutHealthCache.safe) return;
    const reason = this.automaticCutHealthCache.reason;
    await this.signalWithheldCut('interlock', reason, { trackerId, imei, fleetId, plate: plate ?? null });
    throw new AutomaticCutWithheldException(
      `Coupure automatique différée : ${reason}`,
      'interlock',
      reason,
    );
  }

  /**
   * T49 — une ligne par CAUSE, espacée, qui compte les refus et nomme les véhicules depuis la
   * ligne précédente. Le kill-switch (état voulu) en DÉGRADATION toutes les heures au plus ;
   * l'interlock (chaîne de secours non prouvée) en CRITICAL par raison et par quart d'heure.
   * Ne lève jamais.
   */
  private async signalWithheldCut(
    cause: 'kill-switch' | 'interlock',
    reason: string,
    vehicle: { trackerId: string; imei: string; fleetId: string; plate: string | null },
  ): Promise<void> {
    const key = cause === 'kill-switch' ? 'kill-switch' : `interlock|${reason}`;
    const spacing = cause === 'kill-switch' ? ENGINE_KILL_SWITCH_ALERT_SPACING_MS : ENGINE_INTERLOCK_ALERT_SPACING_MS;
    const now = Date.now();
    const entry = this.withheldCuts.get(key) ?? { lastAt: 0, refusals: 0, vehicles: new Set<string>() };
    entry.refusals += 1;
    if (entry.vehicles.size < ENGINE_WITHHELD_MAX_PLATES) entry.vehicles.add(vehicle.plate ?? vehicle.imei);
    this.withheldCuts.set(key, entry);
    if (now - entry.lastAt < spacing) return;

    const refusals = entry.refusals;
    const vehicles = [...entry.vehicles];
    entry.lastAt = now;
    entry.refusals = 0;
    entry.vehicles = new Set<string>();

    const liste = vehicles.length > 0 ? ` — véhicules : ${vehicles.join(', ')}` : '';
    const message = cause === 'kill-switch'
      ? `Coupes automatiques RETENUES par le kill-switch (${reason}) : ${refusals} refus depuis la dernière ligne${liste}. ` +
        'État voulu jusqu’au Go terrain ; les RESTORE et les actions manuelles restent disponibles. Prochaine ligne dans 60 min au plus tôt.'
      : `CUT automatique bloquée : capacité de RESTORE non démontrée (${reason}) : ${refusals} refus depuis la dernière ligne${liste}. Prochaine ligne dans 15 min au plus tôt.`;
    await this.errorLogger.record(
      message,
      'engine-control-interlock',
      {
        cause,
        reason,
        refusalsSinceLastLine: refusals,
        vehicles,
        trackerId: vehicle.trackerId,
        imei: vehicle.imei,
        fleetId: vehicle.fleetId,
        plate: vehicle.plate ?? undefined,
        spacingMin: Math.round(spacing / 60_000),
      },
      cause === 'kill-switch' ? NIVEAU_DEGRADATION : 'CRITICAL',
    ).catch(() => undefined);

    // Prévenir — nuit du 15 au 16/09 : 24 coupes retenues de 22:00 à 04:30, une ligne toutes les
    // 15 min au centre d'alerte, et personne d'averti. Une fois par cause à l'ouverture, puis
    // toutes les heures ; le socle applique encore ses propres bornes.
    if (now - (entry.lastPushAt ?? 0) >= ENGINE_WITHHELD_PUSH_SPACING_MS) {
      entry.lastPushAt = now;
      this.pousserCoupeCircuit({
        kind: 'coupe-retenue',
        subjectKey: key,
        title: cause === 'kill-switch' ? 'Coupes automatiques retenues (kill-switch)' : 'Coupes automatiques retenues',
        body: `${reason} — ${refusals} refus${vehicles.length > 0 ? ` : ${vehicles.slice(0, 6).join(', ')}${vehicles.length > 6 ? '…' : ''}` : ''}. Rien ne coupe tant que la cause n'est pas levée.`,
      });
    }
  }

  /** Événement `coupe-circuit.push` → `CoupeCircuitPushService` (super-admins). Ne lève jamais. */
  private pousserCoupeCircuit(event: CoupeCircuitPushEvent): void {
    try {
      this.events.emit(COUPE_CIRCUIT_PUSH_EVENT, event);
    } catch (err) {
      this.logger.warn({ kind: event.kind, error: err instanceof Error ? err.message : String(err) }, 'push coupe-circuit non émis');
    }
  }

  private async beginAttempt(
    command: EngineControlCommand,
    channel: 'TCP' | 'SMS',
    status: string,
  ): Promise<{ id: string | null; number: number }> {
    const number = Number((command as EngineControlCommand & { attemptCount?: number }).attemptCount ?? 0) + 1;
    const delegate = this.attemptDelegate();
    if (!delegate) return { id: null, number };
    const row = await delegate.create({
      data: { commandId: command.id, attemptNumber: number, channel, status },
      select: { id: true },
    });
    return { id: row.id, number };
  }

  private async finishAttempt(
    id: string | null,
    status: string,
    data: { providerId?: string; smsLogId?: string; rawCode?: string; errorMessage?: string } = {},
  ): Promise<void> {
    if (!id) return;
    await this.attemptDelegate()?.updateMany({
      where: { id },
      data: { status, finishedAt: new Date(), ...data },
    });
  }

  private async dispatchCommand(
    imei: string,
    command: EngineControlCommand,
    action: EngineAction,
    fleetId: string,
    allowSmsOnOfflineRestore = false,
    source?: 'MANUAL' | 'SCHEDULER',
  ): Promise<EngineControlCommand> {
    const cobanCmd: CobanCommand =
      action === EngineAction.CUT
        ? { type: 'engine_stop' }
        : { type: 'engine_resume' };

    const payload = encodeCommand(imei, cobanCmd);

    // Use registry.send() which checks socket.destroyed + has try-catch
    const sent = this.sessionRegistry.send(imei, payload);

    if (!sent) {
      // RESTORE : une absence instantanée de socket ne doit pas consommer un SMS tout de
      // suite. L'intention reste durable, attend une courte reconnexion, puis le worker
      // fera une seconde tentative TCP avant d'autoriser le secours payant.
      if (action === EngineAction.RESTORE && !allowSmsOnOfflineRestore) {
        const attempt = await this.beginAttempt(command, 'TCP', 'UNAVAILABLE');
        const now = new Date();
        await this.finishAttempt(attempt.id, 'UNAVAILABLE', {
          errorMessage: 'Socket TCP absente au premier dispatch',
        });
        const waiting = await this.prisma.engineControlCommand.update({
          where: { id: command.id },
          data: {
            status: CommandStatus.PENDING,
            channel: 'TCP',
            attemptCount: attempt.number,
            lastAttemptAt: now,
            nextAttemptAt: new Date(now.getTime() + ENGINE_ACK_TIMEOUT_MS),
            dispatchLeaseUntil: null,
            lastError: 'Socket TCP absente — reconnexion prioritaire avant secours SMS',
          },
        });
        this.emitUpdate(waiting, fleetId);
        return waiting;
      }

      const attempt = await this.beginAttempt(command, 'SMS', 'QUEUED');
      const smsAttemptNumber = Number(
        (command as EngineControlCommand & { smsAttemptCount?: number }).smsAttemptCount ?? 0,
      ) + 1;
      const smsSent = await this.trySmsFallback(imei, action, command.id, source);
      if (smsSent.ok) {
        await this.finishAttempt(
          attempt.id,
          smsSent.outcome === 'delivered' ? 'DELIVERED' : 'ACCEPTED',
          {
            providerId: smsSent.providerId,
            smsLogId: smsSent.smsLogId,
            rawCode: smsSent.submittedStatus,
          },
        );
        const now = new Date();
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
        // T48 — écriture conditionnelle : une supplantation entre la création et ce point
        // (RESTORE créée pendant l'envoi de la CUT) n'est jamais écrasée.
        const { row: updated } = await this.writeSent(
          command,
          {
            status: CommandStatus.SENT,
            sentAt: now,
            channel: 'SMS',
            lastError: null,
            smsLogId: smsSent.smsLogId ?? null,
            attemptCount: attempt.number,
            smsAttemptCount: smsAttemptNumber,
            lastAttemptAt: now,
            dispatchLeaseUntil: null,
            nextAttemptAt: new Date(now.getTime() + 30_000),
          },
          { imei, redundantSmsLogId: smsSent.smsLogId ?? null },
        );
        this.emitUpdate(updated, fleetId);
        this.logger.log(
          { commandId: command.id, attemptId: attempt.id, imei, channel: 'SMS' },
          'Command accepted by SMS fallback; delivery remains unconfirmed',
        );
        return updated;
      }

      await this.finishAttempt(attempt.id, 'FAILED', { errorMessage: smsSent.reason });

      // RESTORE est asymétrique : un refus de soumission ne l'abandonne pas. Il
      // reste visible et le worker le réessaie avec backoff, puis escalade.
      // T42 — et un budget SMS épuisé ne la rend pas terminale non plus : relance TCP seule.
      if (action === EngineAction.RESTORE) {
        const exhausted = smsAttemptNumber >= ENGINE_RESTORE_MAX_SMS_ATTEMPTS;
        const retryAt = new Date(
          Date.now() +
            (exhausted
              ? ENGINE_RESTORE_TCP_RETRY_MS
              : Math.min(5 * 60_000, 30_000 * smsAttemptNumber)),
        );
        const retrying = await this.prisma.engineControlCommand.update({
          where: { id: command.id },
          data: {
            status: CommandStatus.SENT,
            channel: 'SMS',
            lastError: exhausted
              ? this.smsExhaustedMessage(smsAttemptNumber, smsSent.reason)
              : `Échec SMS : ${smsSent.reason} — nouvel essai planifié`,
            smsLogId: null,
            attemptCount: attempt.number,
            smsAttemptCount: smsAttemptNumber,
            lastAttemptAt: new Date(),
            nextAttemptAt: retryAt,
            dispatchLeaseUntil: null,
          },
        });
        this.emitUpdate(retrying, fleetId);
        this.errorLogger.record(
          exhausted
            ? ENGINE_RESTORE_SMS_EXHAUSTED_ALERT
            : `RESTORE SMS en échec — retry ${smsAttemptNumber + 1}/${ENGINE_RESTORE_MAX_SMS_ATTEMPTS} planifié`,
          'engine-control-restore',
          { imei, commandId: command.id, attemptId: attempt.id, reason: smsSent.reason, retryAt },
          'CRITICAL',
        ).catch(() => undefined);
        return retrying;
      }

      const updated = await this.prisma.engineControlCommand.update({
        where: { id: command.id },
        data: {
          status: CommandStatus.FAILED,
          lastError: `Tracker hors ligne — socket TCP indisponible et repli SMS impossible : ${smsSent.reason}`,
          activeKey: null,
          nextAttemptAt: null,
          dispatchLeaseUntil: null,
          attemptCount: attempt.number,
          smsAttemptCount: smsAttemptNumber,
          lastAttemptAt: new Date(),
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

    const attempt = await this.beginAttempt(command, 'TCP', 'WRITTEN');
    const sentAt = new Date();
    this.wireLogger.out(imei, payload, {
      commandId: command.id,
      attemptId: attempt.id ?? undefined,
      source: 'engine',
    });
    this.logger.log({ commandId: command.id, attemptId: attempt.id, imei, payload }, 'Command dispatched');

    // TRK-018 — le canal est écrit ICI aussi, pas seulement sur le repli. Ne le renseigner
    // que sur le chemin SMS aurait laissé `channel = NULL` sur le chemin nominal : on ne
    // saurait toujours pas distinguer « parti en TCP » de « on ne sait pas ».
    // T48 — écriture conditionnelle (voir writeSent).
    const { row: updated } = await this.writeSent(
      command,
      {
        status: CommandStatus.SENT,
        sentAt,
        channel: 'TCP',
        attemptCount: attempt.number,
        lastAttemptAt: sentAt,
        dispatchLeaseUntil: null,
        nextAttemptAt: action === EngineAction.RESTORE
          ? new Date(sentAt.getTime() + ENGINE_ACK_TIMEOUT_MS)
          : null,
        lastError: null,
      },
      { imei },
    );
    this.emitUpdate(updated, fleetId);

    // Background ACK wait (fire-and-forget, same pattern as TrackerCommandsService)
    const ackPattern = action === EngineAction.CUT
      ? ENGINE_STOP_ACK_PATTERN
      : ENGINE_RESUME_ACK_PATTERN;

    this.ackWaiter
      .waitForAck(imei, ackPattern, ENGINE_ACK_TIMEOUT_MS, command.id, ENGINE_ACK_PRIORITY)
      .then(async (rawAck) => {
        const latencyMs = Date.now() - sentAt.getTime();
        this.wireLogger.ackMatch(imei, rawAck, command.id, latencyMs);
        await this.finishAttempt(attempt.id, 'ACKNOWLEDGED', { rawCode: rawAck });
        try {
          let current: { status: CommandStatus; activeKey: string | null } | null = null;
          try {
            current = await this.prisma.engineControlCommand.findUnique({
              where: { id: command.id },
              select: { status: true, activeKey: true },
            });
          } catch {
            current = null;
          }
          if (current?.status === CommandStatus.SENT_UNCONFIRMED && current.activeKey == null) {
            this.logger.warn(
              { commandId: command.id, attemptId: attempt.id },
              'ACK tardif ignoré : la commande a été supplantée ou clôturée',
            );
            return;
          }
          // T48 — conditionnel : un second écho ne réécrit pas `ackedAt`, et un acquittement posé
          // par un autre chemin (accusé SMS, ignition) n'est pas horodaté deux fois.
          const { count } = await this.prisma.engineControlCommand.updateMany({
            where: { id: command.id, ackedAt: null },
            data: {
              status: CommandStatus.ACKNOWLEDGED,
              ackedAt: new Date(),
              activeKey: null,
              nextAttemptAt: null,
              dispatchLeaseUntil: null,
            },
          });
          if (count !== 1) return;
          const acked = await this.prisma.engineControlCommand.findUnique({ where: { id: command.id } });
          if (acked) this.emitUpdate(acked, fleetId);
        } catch (dbErr) {
          this.logger.error({ commandId: command.id, error: (dbErr as Error).message },
            'Failed to persist ACK status — command stuck as SENT');
          this.errorLogger.record(dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
            'engine-control', { imei, commandId: command.id, attemptId: attempt.id, phase: 'ack-persist' },
          ).catch(() => {});
        }
        this.logger.log({ commandId: command.id, attemptId: attempt.id, latencyMs }, 'Engine command ACK received');
      })
      .catch(async (err) => {
        await this.finishAttempt(attempt.id, 'TIMED_OUT', {
          errorMessage: err instanceof Error ? err.message : 'ACK timeout',
        }).catch(() => undefined);
        if (action === EngineAction.RESTORE) {
          await this.prisma.engineControlCommand.updateMany({
            where: { id: command.id, status: CommandStatus.SENT, ackedAt: null },
            data: {
              nextAttemptAt: new Date(),
              lastError: 'Aucun ACK TCP dans le délai — secours SMS planifié',
            },
          }).catch(() => undefined);
          this.logger.warn(
            { commandId: command.id, attemptId: attempt.id, imei },
            'RESTORE sans ACK TCP — fallback SMS durable planifié',
          );
          return;
        }
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
          { commandId: command.id, attemptId: attempt.id, imei },
          'CUT livrée sur TCP sans ACK applicatif — attente de la preuve ignition',
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
    return updated;
  }

  /** Envoi SMS rejouable utilisé par la sentinelle après timeout TCP/crash. */
  private async dispatchSmsAttempt(
    imei: string,
    command: EngineControlCommand,
    action: EngineAction,
    fleetId: string,
  ): Promise<EngineControlCommand> {
    const attempt = await this.beginAttempt(command, 'SMS', 'QUEUED');
    const smsAttemptNumber = Number(
      (command as EngineControlCommand & { smsAttemptCount?: number }).smsAttemptCount ?? 0,
    ) + 1;
    const result = await this.trySmsFallback(imei, action, command.id);
    const now = new Date();

    if (result.ok) {
      await this.finishAttempt(
        attempt.id,
        result.outcome === 'delivered' ? 'DELIVERED' : 'ACCEPTED',
        {
          providerId: result.providerId,
          smsLogId: result.smsLogId,
          rawCode: result.submittedStatus,
        },
      );
      // T48 — un ACK TCP arrivé pendant l'envoi du SMS gagne : la ligne n'est pas rétrogradée
      // en SENT, et le SMS devenu inutile est annulé au relais.
      const { row: updated } = await this.writeSent(
        command,
        {
          status: CommandStatus.SENT,
          sentAt: command.sentAt ?? now,
          channel: 'SMS',
          smsLogId: result.smsLogId ?? null,
          attemptCount: attempt.number,
          smsAttemptCount: smsAttemptNumber,
          lastAttemptAt: now,
          nextAttemptAt: new Date(now.getTime() + 30_000),
          dispatchLeaseUntil: null,
          lastError: null,
        },
        { imei, redundantSmsLogId: result.smsLogId ?? null },
      );
      this.emitUpdate(updated, fleetId);
      return updated;
    }

    await this.finishAttempt(attempt.id, 'FAILED', { errorMessage: result.reason });
    const exhausted = smsAttemptNumber >= ENGINE_RESTORE_MAX_SMS_ATTEMPTS;
    const updated = await this.prisma.engineControlCommand.update({
      where: { id: command.id },
      data: exhausted
        ? {
            // T42 — jamais terminale : l'intention reste SENT, garde sa clé, et K repart en TCP
            // à la reconnexion du boîtier ou au prochain créneau — plus aucun SMS.
            status: CommandStatus.SENT,
            channel: 'SMS',
            smsLogId: null,
            attemptCount: attempt.number,
            smsAttemptCount: smsAttemptNumber,
            lastAttemptAt: now,
            nextAttemptAt: new Date(now.getTime() + ENGINE_RESTORE_TCP_RETRY_MS),
            dispatchLeaseUntil: null,
            alertedAt: null,
            lastError: this.smsExhaustedMessage(smsAttemptNumber, result.reason),
          }
        : {
            status: CommandStatus.SENT,
            channel: 'SMS',
            smsLogId: null,
            attemptCount: attempt.number,
            smsAttemptCount: smsAttemptNumber,
            lastAttemptAt: now,
            nextAttemptAt: new Date(now.getTime() + Math.min(5 * 60_000, 30_000 * smsAttemptNumber)),
            dispatchLeaseUntil: null,
            lastError: `Échec SMS : ${result.reason} — nouvel essai planifié`,
          },
    });
    this.emitUpdate(updated, fleetId);
    await this.errorLogger.record(
      exhausted
        ? ENGINE_RESTORE_SMS_EXHAUSTED_ALERT
        : `RESTORE SMS en échec — retry ${smsAttemptNumber + 1}/${ENGINE_RESTORE_MAX_SMS_ATTEMPTS} planifié`,
      'engine-control-restore',
      { imei, commandId: command.id, attemptId: attempt.id, reason: result.reason },
      'CRITICAL',
    );
    if (exhausted) {
      // L'alerte immédiate a bien été persistée : évite que la sentinelle la duplique.
      // Si record() lève, ce marquage n'a pas lieu et le cron la retentera.
      await this.prisma.engineControlCommand.updateMany({
        where: { id: command.id, alertedAt: null, ackedAt: null },
        data: { alertedAt: new Date() },
      });
    }
    return updated;
  }

  /**
   * Sentinelle durable RESTORE. Toutes les décisions à reprendre sont en base :
   * le cron peut être interrompu entre deux lignes puis recommencer sans perdre
   * l'intention. Le lease évite deux workers simultanés ; s'il expire après un
   * crash, un doublon RESTORE reste volontairement préférable à un abandon.
   */
  @Cron('*/15 * * * * *', { name: 'engine-restore-reliability' })
  async processPendingRestores(): Promise<void> {
    if (this.restoreWorkerRunning) return;
    this.restoreWorkerRunning = true;
    try {
    const now = new Date();
    const due = await this.prisma.engineControlCommand.findMany({
      where: {
        action: EngineAction.RESTORE,
        status: { in: [CommandStatus.PENDING, CommandStatus.SENT] },
        ackedAt: null,
        AND: [
          { OR: [{ nextAttemptAt: { lte: now } }, { status: CommandStatus.PENDING, nextAttemptAt: null }] },
          { OR: [{ dispatchLeaseUntil: null }, { dispatchLeaseUntil: { lt: now } }] },
        ],
      },
      include: { tracker: { include: { vehicle: true } } },
      orderBy: [{ createdAt: 'asc' }],
      take: 25,
    });

    for (const command of due) {
      const leaseUntil = new Date(Date.now() + ENGINE_DISPATCH_LEASE_MS);
      const claimed = await this.prisma.engineControlCommand.updateMany({
        where: {
          id: command.id,
          ackedAt: null,
          status: { in: [CommandStatus.PENDING, CommandStatus.SENT] },
          OR: [{ dispatchLeaseUntil: null }, { dispatchLeaseUntil: { lt: now } }],
        },
        data: { dispatchLeaseUntil: leaseUntil },
      });
      if (claimed.count !== 1) continue;

      const fleetId = command.tracker.vehicle?.fleetId;
      if (!fleetId) {
        await this.prisma.engineControlCommand.update({
          where: { id: command.id },
          data: {
            status: CommandStatus.FAILED,
            activeKey: null,
            nextAttemptAt: null,
            dispatchLeaseUntil: null,
            alertedAt: null,
            lastError: 'RESTORE sans véhicule/flotte : intervention humaine requise',
          },
        });
        continue;
      }

      try {
        // T42 — une RESTORE ne transmet JAMAIS après une COUPURE plus récente qu'elle. Vérifié
        // ici, au seul endroit qui (ré)émet, quel que soit le chemin qui l'a réveillée.
        if (await this.restoreSupplanteeParCut(command)) {
          const closed = await this.prisma.engineControlCommand.update({
            where: { id: command.id },
            data: {
              status: CommandStatus.SENT_UNCONFIRMED,
              activeKey: null,
              nextAttemptAt: null,
              dispatchLeaseUntil: null,
              expiredAt: new Date(),
              lastError: RESTORE_SUPPLANTEE_PAR_CUT,
            },
          });
          this.emitUpdate(closed, fleetId);
          this.logger.warn(
            { commandId: command.id, imei: command.tracker.imei },
            'RESTORE close sans envoi : une COUPURE plus récente la supplante (T42)',
          );
          continue;
        }

        // T42 — budget SMS épuisé (et plus aucun SMS en vol) : plus un SMS, K renvoyée en TCP
        // seulement, à la reconnexion puis toutes les ENGINE_RESTORE_TCP_RETRY_MS.
        if (this.smsBudgetExhausted(command)) {
          await this.retryTcpOnly(command.tracker.imei, command, fleetId);
          continue;
        }

        // T62 — SIM injoignable par SMS et aucun SMS en vol : TCP toutes les 5 min, et un
        // SMS-sonde au plus toutes les 6 h (s'il passe, la série d'échecs est rompue).
        if (!command.smsLogId) {
          const reach = await this.smsReachability(command.tracker.simPhoneNumber ?? null);
          if (reach.unreachable && !this.smsProbeDue(reach)) {
            await this.retryTcpOnly(
              command.tracker.imei,
              command,
              fleetId,
              ENGINE_TCP_ONLY_RETRY_MS,
              `SIM injoignable par SMS (${reach.streak} échecs consécutifs) — TCP seul, prochaine sonde SMS dans ${Math.round(
                Math.max(0, ENGINE_SMS_PROBE_INTERVAL_MS - (Date.now() - (reach.lastFailureAt?.getTime() ?? 0))) / 60_000,
              )} min`,
            );
            continue;
          }
        }

        if (command.status === CommandStatus.PENDING) {
          await this.dispatchCommand(
            command.tracker.imei,
            command,
            command.action,
            fleetId,
            command.channel === 'TCP',
          );
          continue;
        }

        // TCP écrit sans ACK après son échéance : le fallback n'est plus abandonné.
        if (command.channel === 'TCP') {
          await this.dispatchSmsAttempt(command.tracker.imei, command, command.action, fleetId);
          continue;
        }

        if (!command.smsLogId) {
          await this.dispatchSmsAttempt(command.tracker.imei, command, command.action, fleetId);
          continue;
        }

        const reconciliation = await this.sms.reconcileOutboundStatus(command.smsLogId);
        if (reconciliation?.outcome === 'delivered') {
          await this.attemptDelegate()?.updateMany({
            where: { commandId: command.id, smsLogId: command.smsLogId },
            data: { status: 'DELIVERED', finishedAt: new Date(), rawCode: reconciliation.status ?? undefined },
          });
          await this.prisma.engineControlCommand.update({
            where: { id: command.id },
            data: {
              nextAttemptAt: null,
              dispatchLeaseUntil: null,
              lastError: 'SMS remis au téléphone — exécution boîtier encore non confirmée',
            },
          });
          continue;
        }

        if (reconciliation?.outcome === 'failed') {
          await this.attemptDelegate()?.updateMany({
            where: { commandId: command.id, smsLogId: command.smsLogId },
            data: { status: 'FAILED', finishedAt: new Date(), rawCode: reconciliation.status ?? undefined },
          });
          const smsAttemptCount = Number(
            (command as EngineControlCommand & { smsAttemptCount?: number }).smsAttemptCount ?? command.attemptCount,
          );
          if (smsAttemptCount < ENGINE_RESTORE_MAX_SMS_ATTEMPTS) {
            const retryAt = new Date(Date.now() + Math.min(5 * 60_000, 30_000 * Math.max(1, smsAttemptCount)));
            await this.prisma.engineControlCommand.update({
              where: { id: command.id },
              data: {
                smsLogId: null,
                nextAttemptAt: retryAt,
                dispatchLeaseUntil: null,
                lastError: `Échec SMS terminal (${reconciliation.status ?? 'inconnu'}) — retry planifié`,
              },
            });
          } else {
            // T42 — secours SMS épuisé : l'intention reste ouverte, relance TCP seule.
            const reason = `échec SMS terminal (${reconciliation.status ?? 'inconnu'})`;
            const kept = await this.prisma.engineControlCommand.update({
              where: { id: command.id },
              data: {
                status: CommandStatus.SENT,
                smsLogId: null,
                nextAttemptAt: new Date(Date.now() + ENGINE_RESTORE_TCP_RETRY_MS),
                dispatchLeaseUntil: null,
                lastError: this.smsExhaustedMessage(smsAttemptCount, reason),
              },
            });
            this.emitUpdate(kept, fleetId);
            await this.errorLogger.record(
              ENGINE_RESTORE_SMS_EXHAUSTED_ALERT,
              'engine-control-restore',
              { imei: command.tracker.imei, commandId: command.id, reason, smsAttemptCount },
              'CRITICAL',
            ).catch(() => undefined);
          }
          continue;
        }

        // T51 — un SMS en file depuis plus d'une heure ne partira probablement plus tel quel
        // (téléphone éteint, application tuée) : on l'annule au relais (best-effort, T41) et on
        // laisse le worker retenter au tick suivant — le budget SMS le compte, pas un de plus.
        const queuedSince = command.lastAttemptAt ?? command.sentAt ?? command.createdAt;
        if (Date.now() - queuedSince.getTime() > ENGINE_RESTORE_SMS_STUCK_MS) {
          const cancel = await this.sms.cancelOutbound(command.smsLogId).catch((err) => ({
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
          }));
          const stuck = await this.prisma.engineControlCommand.update({
            where: { id: command.id },
            data: {
              smsLogId: null,
              nextAttemptAt: new Date(),
              dispatchLeaseUntil: null,
              lastError: `SMS en file depuis plus de ${Math.round(ENGINE_RESTORE_SMS_STUCK_MS / 60_000)} min sans départ — ${cancel.ok ? 'annulé au relais' : `annulation refusée (${cancel.reason ?? 'sans raison'})`}, nouvelle tentative`,
            },
          });
          this.emitUpdate(stuck, fleetId);
          this.logger.warn(
            { commandId: command.id, imei: command.tracker.imei, smsLogId: command.smsLogId, cancelled: cancel.ok },
            'RESTORE : SMS bloqué en file depuis plus d’une heure, retenté (T51)',
          );
          continue;
        }

        // Toujours queued/accepted : on repollera, sans envoyer un doublon ambigu.
        await this.prisma.engineControlCommand.update({
          where: { id: command.id },
          data: { nextAttemptAt: new Date(Date.now() + 30_000), dispatchLeaseUntil: null },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.engineControlCommand.updateMany({
          where: { id: command.id, ackedAt: null },
          data: {
            nextAttemptAt: new Date(Date.now() + 30_000),
            dispatchLeaseUntil: null,
            lastError: `Worker RESTORE en erreur : ${message}`,
          },
        }).catch(() => undefined);
        this.errorLogger.record(
          'Worker RESTORE en erreur — intention conservée pour reprise',
          'engine-control-restore',
          { commandId: command.id, imei: command.tracker.imei, error: message },
          'CRITICAL',
        ).catch(() => undefined);
      }
    }

      await this.alertOverdueRestores();
    } finally {
      this.restoreWorkerRunning = false;
    }
  }

  /** T42 — plus aucun SMS possible pour cette intention : budget consommé et rien en vol. */
  private smsBudgetExhausted(command: EngineControlCommand): boolean {
    const count = Number(
      (command as EngineControlCommand & { smsAttemptCount?: number }).smsAttemptCount ?? 0,
    );
    return count >= ENGINE_RESTORE_MAX_SMS_ATTEMPTS && !command.smsLogId;
  }

  private smsExhaustedMessage(smsAttemptCount: number, reason: string): string {
    return (
      `RESTORE non transmise après ${smsAttemptCount} tentative(s) SMS (${reason}) — secours SMS épuisé : ` +
      `K sera renvoyée en TCP dès la reconnexion du boîtier et toutes les ${Math.round(ENGINE_RESTORE_TCP_RETRY_MS / 60000)} min ; vérifier le véhicule`
    );
  }

  /**
   * T42 — relance TCP SEULE d'une RESTORE dont le secours SMS est épuisé. Jamais de SMS ici : le
   * budget est par intention, et une reconnexion n'est pas une demande neuve. Socket absente →
   * prochain créneau, rien d'autre qu'une date. Socket présente → K écrite, ACK attendu ; sans
   * ACK, prochain créneau. `sentAt` n'est posé qu'à la PREMIÈRE transmission : l'échéance de 4 h
   * court depuis celle-là, pas depuis la dernière relance.
   */
  private async retryTcpOnly(
    imei: string,
    command: EngineControlCommand,
    fleetId: string,
    retryMs: number = ENGINE_RESTORE_TCP_RETRY_MS,
    motif = 'Secours SMS épuisé',
  ): Promise<void> {
    const retryAt = new Date(Date.now() + retryMs);
    const payload = encodeCommand(imei, { type: 'engine_resume' });
    const sent = this.sessionRegistry.send(imei, payload);
    if (!sent) {
      const waiting = await this.prisma.engineControlCommand.update({
        where: { id: command.id },
        data: {
          status: CommandStatus.SENT,
          nextAttemptAt: retryAt,
          dispatchLeaseUntil: null,
          lastError: `${motif} et boîtier hors ligne — K sera renvoyée dès sa reconnexion ou au prochain créneau`,
        },
      });
      this.emitUpdate(waiting, fleetId);
      return;
    }

    const attempt = await this.beginAttempt(command, 'TCP', 'WRITTEN');
    const writtenAt = new Date();
    this.wireLogger.out(imei, payload, {
      commandId: command.id,
      attemptId: attempt.id ?? undefined,
      source: 'engine',
    });
    const updated = await this.prisma.engineControlCommand.update({
      where: { id: command.id },
      data: {
        status: CommandStatus.SENT,
        channel: 'TCP',
        sentAt: command.sentAt ?? writtenAt,
        attemptCount: attempt.number,
        lastAttemptAt: writtenAt,
        nextAttemptAt: retryAt,
        dispatchLeaseUntil: null,
        lastError: `${motif} — K renvoyée en TCP, en attente d’ACK`,
      },
    });
    this.emitUpdate(updated, fleetId);
    this.logger.log({ commandId: command.id, attemptId: attempt.id, imei, motif }, 'RESTORE relancée en TCP seul (T42/T62)');

    this.ackWaiter
      .waitForAck(imei, ENGINE_RESUME_ACK_PATTERN, ENGINE_ACK_TIMEOUT_MS, command.id, ENGINE_ACK_PRIORITY)
      .then(async (rawAck) => {
        this.wireLogger.ackMatch(imei, rawAck, command.id, Date.now() - writtenAt.getTime());
        await this.finishAttempt(attempt.id, 'ACKNOWLEDGED', { rawCode: rawAck }).catch(() => undefined);
        try {
          // Conditionnel : jamais réécrire une commande déjà close ou supplantée entre-temps.
          const { count } = await this.prisma.engineControlCommand.updateMany({
            where: { id: command.id, status: CommandStatus.SENT, ackedAt: null },
            data: {
              status: CommandStatus.ACKNOWLEDGED,
              ackedAt: new Date(),
              activeKey: null,
              nextAttemptAt: null,
              dispatchLeaseUntil: null,
              lastError: null,
            },
          });
          if (count !== 1) return;
          const acked = await this.prisma.engineControlCommand.findUnique({ where: { id: command.id } });
          if (acked) this.emitUpdate(acked, fleetId);
          this.logger.log({ commandId: command.id, imei }, 'RESTORE acquittée après relance TCP (T42)');
        } catch (dbErr) {
          this.logger.error(
            { commandId: command.id, error: (dbErr as Error).message },
            'Failed to persist ACK status after TCP-only retry — command stuck as SENT',
          );
          this.errorLogger.record(dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
            'engine-control', { imei, commandId: command.id, attemptId: attempt.id, phase: 'ack-persist' },
          ).catch(() => {});
        }
      })
      .catch(async (err) => {
        await this.finishAttempt(attempt.id, 'TIMED_OUT', {
          errorMessage: err instanceof Error ? err.message : 'ACK timeout',
        }).catch(() => undefined);
        this.logger.warn(
          { commandId: command.id, attemptId: attempt.id, imei },
          'Relance TCP sans ACK — prochain créneau ou reconnexion (T42)',
        );
      });
  }

  private async alertOverdueRestores(): Promise<void> {
    const overdue = await this.prisma.engineControlCommand.findMany({
      where: {
        action: EngineAction.RESTORE,
        // FAILED est inclus : si l'alerte immédiate n'a pas pu être persistée, le
        // terminal reste durablement visible et sera remonté au prochain passage.
        status: { in: [CommandStatus.PENDING, CommandStatus.SENT, CommandStatus.FAILED] },
        ackedAt: null,
        // T51 — jamais alertée, OU alertée il y a plus de ENGINE_RESTORE_REALERT_MS : tant
        // qu'une RESTORE n'est pas prouvée, elle se rappelle — un silence de plusieurs heures
        // après une seule ligne était le défaut.
        OR: [
          { alertedAt: null },
          { alertedAt: { lt: new Date(Date.now() - ENGINE_RESTORE_REALERT_MS) } },
        ],
        // Bornée des deux côtés : assez vieille pour être en retard, assez récente pour être
        // encore un geste à faire (ENGINE_RESTORE_ALERT_WINDOW_MS) — sinon l'historique
        // `FAILED` d'avant la migration remonte à chaque passage.
        createdAt: {
          lte: new Date(Date.now() - ENGINE_RESTORE_ALERT_AFTER_MS),
          gte: new Date(Date.now() - ENGINE_RESTORE_ALERT_WINDOW_MS),
        },
      },
      include: { tracker: { include: { vehicle: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    for (const command of overdue) {
      const alertedAt = new Date();
      const previousAlertAt = command.alertedAt ?? null;
      // Comparaison-et-échange sur la valeur lue : deux instances ne rappellent pas deux fois.
      const marked = await this.prisma.engineControlCommand.updateMany({
        where: { id: command.id, alertedAt: previousAlertAt, ackedAt: null },
        data: { alertedAt },
      });
      if (marked.count !== 1) continue;
      const ageMin = Math.round((Date.now() - command.createdAt.getTime()) / 60_000);
      try {
        await this.errorLogger.record(
          command.status === CommandStatus.FAILED
            ? 'RESTORE en échec terminal — intervention humaine obligatoire'
            : previousAlertAt
              ? `RESTORE toujours non confirmée depuis ${ageMin} min (rappel toutes les ${Math.round(ENGINE_RESTORE_REALERT_MS / 60_000)} min tant qu'elle n'est pas prouvée)`
              : `RESTORE non confirmé depuis plus de ${Math.round(ENGINE_RESTORE_ALERT_AFTER_MS / 1000)} s`,
          'engine-control-restore',
          {
            reminder: previousAlertAt != null,
            commandId: command.id,
            trackerId: command.trackerId,
            imei: command.tracker.imei,
            plate: command.tracker.vehicle?.plate ?? undefined,
            fleetId: command.tracker.vehicle?.fleetId ?? undefined,
            channel: command.channel ?? undefined,
            attemptCount: command.attemptCount,
            lastError: command.lastError ?? undefined,
            ageMs: Date.now() - command.createdAt.getTime(),
            actionRequired: 'Vérifier le véhicule et déclencher la procédure manuelle de restauration',
          },
          'CRITICAL',
        );
        // Prévenir — hier GS-928-NX est resté immobilisé 2 h 56 : la première alerte, l'échec
        // terminal, puis un rappel par heure (le centre d'alerte, lui, rappelle tous les quarts
        // d'heure). C'est le cas où un conducteur attend devant un véhicule qui ne démarre pas.
        const terminal = command.status === CommandStatus.FAILED;
        if (!previousAlertAt || terminal || ageMin % 60 < Math.round(ENGINE_RESTORE_REALERT_MS / 60_000)) {
          const plaque = command.tracker.vehicle?.plate ?? command.tracker.imei;
          this.pousserCoupeCircuit({
            kind: 'restore-non-prouvee',
            subjectKey: command.id,
            title: terminal ? `Remise en route en échec — ${plaque}` : `Remise en route non confirmée — ${plaque}`,
            body: terminal
              ? `Le véhicule est peut-être immobilisé : intervention manuelle (${command.lastError ?? 'sans détail'}).`
              : `Non confirmée depuis ${ageMin} min (canal ${command.channel ?? '?'}, ${command.attemptCount} tentative(s)) — relances en cours, vérifier le véhicule.`,
          });
        }
      } catch (err) {
        // Ne jamais mémoriser « alerté » si le centre d'alertes n'a rien persisté.
        // La remise à null autorise le prochain passage à retenter.
        await this.prisma.engineControlCommand.updateMany({
          where: { id: command.id, alertedAt },
          data: { alertedAt: previousAlertAt },
        }).catch(() => undefined);
        this.logger.error(
          { commandId: command.id, error: err instanceof Error ? err.message : String(err) },
          'Sentinelle RESTORE non persistée — elle sera retentée',
        );
      }
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
        channel: command.channel,
        attemptCount: command.attemptCount,
        nextAttemptAt: command.nextAttemptAt?.toISOString() ?? null,
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
    source?: 'MANUAL' | 'SCHEDULER',
  ): Promise<
    | {
        ok: true;
        outcome: 'accepted' | 'delivered';
        smsLogId?: string;
        providerId?: string;
        submittedStatus?: string;
      }
    | { ok: false; reason: string }
  > {
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
    // T62 — une COUPURE automatique ne dépense pas un SMS vers une SIM que rien n'atteint : la
    // coupe est reportée ou échoue proprement. Une action MANUELLE (antivol) tente sa chance —
    // et, si elle passe, rompt la série d'échecs.
    if (action === EngineAction.CUT && source === 'SCHEDULER') {
      const reach = await this.smsReachability(tracker.simPhoneNumber);
      if (reach.unreachable) {
        return {
          ok: false,
          reason: `SIM injoignable par SMS (${reach.streak} échecs consécutifs) — aucun SMS envoyé, véhicule en TCP seul`,
        };
      }
    }
    const smsPayload = action === EngineAction.CUT ? 'stop123456' : 'resume123456';
    const result = await this.sms.send(tracker.simPhoneNumber, smsPayload, {
      imei,
      commandId,
      action,
      priority: action === EngineAction.RESTORE ? 'critical_restore' : 'engine_cut',
      // T41 — une COUPURE périme (le téléphone n'émet plus un `stop` en retard) ; une remise en
      // route ne périme jamais et passe devant tout le reste sur le téléphone.
      ...(action === EngineAction.CUT
        ? { ttlSeconds: ENGINE_CUT_SMS_TTL_S }
        : { smsPriority: ENGINE_RESTORE_SMS_PRIORITY }),
      template: 'engine_control_fallback', source: 'engine-control-fallback',
    });
    if (result.ok) {
      return {
        ok: true,
        outcome: result.outcome === 'delivered' ? 'delivered' : 'accepted',
        smsLogId: result.smsLogId,
        providerId: result.twilioSid,
        submittedStatus: result.submittedStatus,
      };
    }
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

  /**
   * ══ TRK-018 nº 4 — LES IMMOBILISATIONS QUE PERSONNE NE PEUT CONFIRMER ═══════════════════
   *
   * Les correctifs 1 à 3 ont rendu l'état LISIBLE EN BASE : les commandes moteur sans preuve
   * de remise ne pourrissent plus en `SENT` à vie, elles portent `SENT_UNCONFIRMED` — « nul ne
   * sait » — et le canal réellement emprunté est écrit dans `channel`. Il manquait l'écran :
   * un exploitant n'ouvre pas psql.
   *
   * 🔑 **Ce que cet écran montre est une CÉCITÉ, pas une panne.** Rien ici ne prouve qu'un
   * véhicule n'a pas été immobilisé — seulement que *personne ne peut l'affirmer*. Le
   * coupe-circuit est une garde de sécurité : une garde qu'on croit armée sans preuve est plus
   * dangereuse qu'une garde qu'on sait muette. Le vocabulaire de la réponse suit cette règle et
   * n'emploie jamais « échec ».
   *
   * ⚠️ `ackedAt` n'est jamais écrit par ce chemin, et cette méthode est en LECTURE SEULE :
   * faire disparaître ces lignes supprimerait la seule trace de la question.
   */
  async listUnconfirmedImmobilisations(
    requestedBy: RequestedBy,
    filters?: { days?: number },
  ): Promise<{
    fenetreJours: number;
    resume: {
      total: number;
      dernieres24h: number;
      derniers7j: number;
      parCanal: { TCP: number; SMS: number; INCONNU: number };
      vehiculesConcernes: number;
      plusAncienneHeures: number | null;
      restaurationsEnCours: number;
      retriesPlanifies: number;
      alertesEmises: number;
    };
    parVehicule: {
      vehicleId: string | null;
      plaque: string;
      total: number;
      viaSms: number;
      canalInconnu: number;
      derniere: string;
    }[];
    recentes: {
      id: string;
      creeLe: string;
      action: string;
      statut: string;
      canal: 'TCP' | 'SMS' | 'INCONNU';
      plaque: string;
      origine: string;
      ageHeures: number;
      tentatives: number;
      prochainEssai: string | null;
      alerteEmise: boolean;
      dernierBlocage: string | null;
    }[];
  }> {
    // Fail-closed, exactement comme `listCommands` : un non-super sans flotte ne voit RIEN.
    const scope = resolveTenantScope(requestedBy);
    const vide = {
      fenetreJours: 0,
      resume: {
        total: 0, dernieres24h: 0, derniers7j: 0,
        parCanal: { TCP: 0, SMS: 0, INCONNU: 0 },
        vehiculesConcernes: 0, plusAncienneHeures: null,
        restaurationsEnCours: 0, retriesPlanifies: 0, alertesEmises: 0,
      },
      parVehicule: [],
      recentes: [],
    };
    if (scope.mode === 'DENY') return vide;

    const days = Math.min(Math.max(filters?.days ?? 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const where: Prisma.EngineControlCommandWhereInput = {
      // « Nul ne sait » = la fin de vie du correctif nº 2, plus les `SENT` d'avant sa mise en
      // ligne qui n'ont jamais été balayés. Jamais `FAILED` : un échec CONNU n'est pas une cécité.
      status: { in: [CommandStatus.SENT_UNCONFIRMED, CommandStatus.SENT] },
      ackedAt: null,
      createdAt: { gte: since },
    };
    if (scope.mode === 'FLEET') {
      where.tracker = { vehicle: { fleetId: scope.fleetId } };
    }

    const lignes = await this.prisma.engineControlCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { tracker: { include: { vehicle: true } } },
      // Borne dure : cet écran informe, il ne pagine pas. Le résumé, lui, porte sur ce lot.
      take: 500,
    });

    const maintenant = Date.now();
    const heures = (d: Date) => Math.round(((maintenant - d.getTime()) / 3600_000) * 10) / 10;
    const canalDe = (c: string | null): 'TCP' | 'SMS' | 'INCONNU' =>
      c === 'TCP' || c === 'SMS' ? c : 'INCONNU';

    const parCanal = { TCP: 0, SMS: 0, INCONNU: 0 };
    const parVehicule = new Map<
      string,
      { vehicleId: string | null; plaque: string; total: number; viaSms: number; canalInconnu: number; derniere: Date }
    >();

    for (const l of lignes) {
      const canal = canalDe(l.channel);
      parCanal[canal] += 1;
      const v = l.tracker?.vehicle ?? null;
      const cle = v?.id ?? `imei:${l.tracker?.imei ?? l.trackerId}`;
      const courant = parVehicule.get(cle);
      if (courant) {
        courant.total += 1;
        if (canal === 'SMS') courant.viaSms += 1;
        if (canal === 'INCONNU') courant.canalInconnu += 1;
        if (l.createdAt > courant.derniere) courant.derniere = l.createdAt;
      } else {
        parVehicule.set(cle, {
          vehicleId: v?.id ?? null,
          plaque: v?.plate ?? '(sans véhicule)',
          total: 1,
          viaSms: canal === 'SMS' ? 1 : 0,
          canalInconnu: canal === 'INCONNU' ? 1 : 0,
          derniere: l.createdAt,
        });
      }
    }

    const seuil24 = maintenant - 24 * 3600_000;
    const seuil7j = maintenant - 7 * 24 * 3600_000;

    return {
      fenetreJours: days,
      resume: {
        total: lignes.length,
        dernieres24h: lignes.filter((l) => l.createdAt.getTime() >= seuil24).length,
        derniers7j: lignes.filter((l) => l.createdAt.getTime() >= seuil7j).length,
        parCanal,
        vehiculesConcernes: parVehicule.size,
        plusAncienneHeures: lignes.length ? heures(lignes[lignes.length - 1].createdAt) : null,
        restaurationsEnCours: lignes.filter(
          (l) => l.action === EngineAction.RESTORE && l.status === CommandStatus.SENT,
        ).length,
        retriesPlanifies: lignes.filter((l) => l.nextAttemptAt != null).length,
        alertesEmises: lignes.filter((l) => l.alertedAt != null).length,
      },
      parVehicule: [...parVehicule.values()]
        .sort((a, b) => b.total - a.total || b.derniere.getTime() - a.derniere.getTime())
        .map((v) => ({
          vehicleId: v.vehicleId,
          plaque: v.plaque,
          total: v.total,
          viaSms: v.viaSms,
          canalInconnu: v.canalInconnu,
          derniere: v.derniere.toISOString(),
        })),
      recentes: lignes.slice(0, 60).map((l) => ({
        id: l.id,
        creeLe: l.createdAt.toISOString(),
        action: l.action,
        statut: l.status,
        canal: canalDe(l.channel),
        plaque: l.tracker?.vehicle?.plate ?? '(sans véhicule)',
        origine: l.source,
        ageHeures: heures(l.createdAt),
        tentatives: l.attemptCount,
        prochainEssai: l.nextAttemptAt?.toISOString() ?? null,
        alerteEmise: l.alertedAt != null,
        dernierBlocage: l.lastError,
      })),
    };
  }
}
