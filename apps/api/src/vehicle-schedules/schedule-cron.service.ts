import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { CommandStatus, EngineAction, type VehicleSchedule } from '@prisma/client';
import { DORMANT_STOP_ACTING_MS, formatSilenceLabel, trackerSilenceMs } from '@vizyo/tracky-shared';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { EngineControlService } from '../engine-control/engine-control.service';
import { evaluateSchedule, type EvaluationResult } from './schedule-evaluator';

const DAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

type DayName = (typeof DAYS)[number];

/** Event emis a chaque transition auto — consomme par Sprint M (notifications). */
export interface ScheduleTransitionEvent {
  scheduleId: string;
  vehicleId: string;
  fleetId: string;
  trackerId: string;
  action: 'CUT' | 'RESTORE';
  reason: string;
  windowDesc: string | null;
  occurredAt: string;
}

/** System user ID for scheduler-initiated commands. */
const SCHEDULER_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Revue (incident FS-253) — une coupe/reprise horaire qui n'ABOUTIT PAS depuis ce délai est
 * REMONTÉE au centre d'alertes. Jusqu'ici les reports étaient 100 % silencieux : un véhicule qui
 * ne pouvait jamais être coupé (ex. GPS muet, boîtier hors ligne) passait inaperçu. Ré-alerte
 * espacée (STUCK_REALERT_MS) pour ne pas spammer. Seuil réglable via `SCHEDULE_STUCK_ALERT_MIN`.
 */
const STUCK_ALERT_MS = Math.max(1, Number(process.env.SCHEDULE_STUCK_ALERT_MIN) || 30) * 60 * 1000;
const STUCK_REALERT_MS = 3 * 60 * 60 * 1000;

/**
 * Backoff des COUPES en échec (incident 2026-07-19).
 *
 * Une coupe qui échoue était retentée à CHAQUE tick, donc toutes les minutes, sans fin : 84
 * tentatives par véhicule en une nuit. Chaque tentative crée une commande, tente le TCP, tente le
 * SMS et journalise — 12 véhicules injoignables ont ainsi produit 954 commandes en échec et ~1000
 * lignes au centre d'alerte. Le diagnostic réel (un « + » manquant) était noyé dedans.
 *
 * ⚠️ ASYMÉTRIE VOLONTAIRE : ce backoff ne s'applique QU'À LA COUPE. Une RESTAURATION est retentée
 * à chaque tick, sans délai — rater une coupe est un désagrément, rater une restauration immobilise
 * un véhicule. Ne jamais « harmoniser » les deux.
 *
 * Palier par nombre d'échecs consécutifs (2 min, 5, 15, puis 30 max) : sur une nuit de 12 h on
 * passe de ~720 tentatives à ~25, sans jamais renoncer à couper.
 */
const CUT_BACKOFF_MS = [2, 5, 15, 30].map((m) => m * 60 * 1000);

/** Ré-alerte « planning suspendu pour dormance » : hebdomadaire (l'état est stable). */
const DORMANT_REALERT_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class ScheduleCronService {
  private readonly logger = new Logger(ScheduleCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engineControl: EngineControlService,
    private readonly errorLogger: ErrorLogger,
    private readonly events: EventEmitter2,
  ) {}

  private running = false;

  /** Suivi in-memory des reports (surtout coupes) par véhicule → détection des coupes « bloquées ». */
  private readonly deferredSince = new Map<string, number>();
  private readonly lastStuckAlertAt = new Map<string, number>();
  /** Backoff des COUPES : instant avant lequel on ne retente pas, et compteur d'échecs consécutifs. */
  private readonly cutRetryAfter = new Map<string, number>();
  private readonly cutFailures = new Map<string, number>();
  /**
   * DERNIÈRE cause RÉELLE de refus par véhicule (« Aucune position connue », « véhicule en
   * mouvement », « tracker hors ligne »…).
   *
   * Sans elle, l'alerte « coupe impossible » partait presque toujours pendant une fenêtre de
   * backoff et rapportait donc `coupe en attente de nouvelle tentative (backoff)` — une phrase
   * circulaire qui dit que la coupe attend parce qu'elle attend. Constat au centre d'alerte le
   * 2026-07-27 : 16 lignes sur 16 rédigées ainsi, AUCUNE ne nommant la cause. C'est mécanique —
   * le backoff plafonne à 30 min et le seuil d'alerte est à 30 min, donc l'alerte tombe presque
   * toujours pendant l'attente, jamais sur le tick qui a réellement échoué.
   */
  private readonly lastFailureReason = new Map<string, string>();
  /** Dernière alerte « planning suspendu pour dormance » par véhicule (anti-répétition). */
  private readonly lastDormantAlertAt = new Map<string, number>();

  /** Runs every minute. */
  @Cron('0 * * * * *')
  async evaluate(): Promise<void> {
    // Garde anti-chevauchement : un tick qui déborde (beaucoup de plannings ×
    // commandes moteur) ne doit pas empiler des runs concurrents (risque de
    // saturation CPU). On saute et on reprend au tick suivant — l'état est
    // ré-évalué depuis la DB, rien n'est perdu. Le try/catch protège aussi d'un
    // rejet de la requête globale (unhandled rejection).
    if (this.running) {
      this.logger.warn('Schedule cron: tick précédent encore en cours — skip');
      return;
    }
    this.running = true;
    try {
      await this.evaluateAll();
    } catch (err) {
      this.logger.error({ error: (err as Error).message }, 'Schedule cron tick failed');
      this.errorLogger
        .record(err instanceof Error ? err : new Error(String(err)), 'schedule-cron', { phase: 'tick' })
        .catch(() => { /* best-effort */ });
    } finally {
      this.running = false;
    }
  }

  private async evaluateAll(): Promise<void> {
    const schedules = await this.prisma.vehicleSchedule.findMany({
      where: { enabled: true },
      include: {
        vehicle: {
          include: {
            tracker: true,
          },
        },
      },
    });

    for (const schedule of schedules) {
      try {
        await this.evaluateOne(schedule as ScheduleWithVehicle);
      } catch (err) {
        this.logger.warn(
          { vehicleId: schedule.vehicleId, error: (err as Error).message },
          'Schedule evaluation failed',
        );
        this.errorLogger.record(
          err instanceof Error ? err : new Error(String(err)),
          'schedule-cron',
          { vehicleId: schedule.vehicleId },
        ).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
      }
    }
  }

  async evaluateOne(
    schedule: ScheduleWithVehicle,
  ): Promise<void> {
    const tracker = schedule.vehicle.tracker;
    if (!tracker) return; // no tracker → nothing to do

    // ── Véhicule DORMANT : on cesse d'agir ────────────────────────────────
    // Un boîtier muet depuis des jours ne répondra pas. Continuer à l'évaluer
    // chaque minute revient à retenter une coupe dont on connaît déjà l'issue :
    // en production, FV-941-LZ (89 j de silence) et FL-787-KV (52 j) produisaient
    // ainsi ~48 tentatives par jour CHACUNE — commande créée en base, TCP tenté,
    // SMS tenté, alerte journalisée — noyant les vrais problèmes d'exploitation.
    //
    // Dérivé de la donnée (aucun drapeau, aucune écriture) : dès la première trame
    // reçue, `lastSeenAt` redevient frais et le véhicule réintègre le flux au tick
    // suivant, en moins d'une minute, sans aucun geste d'exploitant.
    //
    // ⚠️ Le `clearDeferral` est OBLIGATOIRE : sans lui, les 4 Map de suivi
    // (report, backoff, compteur d'échecs, dernière cause) garderaient une entrée
    // par véhicule dormant indéfiniment — une fuite mémoire lente.
    const silentMs = trackerSilenceMs(tracker.lastSeenAt);
    if (silentMs != null && silentMs > DORMANT_STOP_ACTING_MS) {
      this.clearDeferral(schedule.vehicleId);
      this.reportDormant(schedule, tracker.lastSeenAt ?? null);
      return;
    }

    // Check manual override
    if (schedule.overrideUntil && new Date() < schedule.overrideUntil) {
      this.logger.debug(
        { vehicleId: schedule.vehicleId },
        'Skipping: manual override active',
      );
      return;
    }

    // V1.5 (Sprint K) — utilise l'evaluateur V2 (multi-plages + jours feries
    // + dates speciales). Le helper retourne aussi la raison + la description
    // de la fenetre, qu'on persiste dans schedule_history pour l'audit.
    const evaluation = evaluateSchedule(schedule);
    const state = evaluation.state;

    // No change → skip (schedule en phase avec l'état voulu → pas de coupe bloquée)
    if (state === schedule.lastEvaluatedState) { this.clearDeferral(schedule.vehicleId); return; }

    // Premier tick apres activation : si IN_WINDOW, le vehicule roule deja.
    // On initialise le baseline sans envoyer de RESTORE inutile.
    if (schedule.lastEvaluatedState === null && state === 'IN_WINDOW') {
      await this.prisma.vehicleSchedule.update({
        where: { id: schedule.id },
        data: { lastEvaluatedState: state, lastEvaluatedAt: new Date() },
      });
      this.logger.log(
        { vehicleId: schedule.vehicleId, state },
        'Schedule baseline initialized (vehicle in window, no action)',
      );
      this.clearDeferral(schedule.vehicleId);
      return;
    }

    const action =
      state === 'IN_WINDOW' ? EngineAction.RESTORE : EngineAction.CUT;

    // Backoff des coupes en échec : on n'appelle même pas le moteur de commande tant que le délai
    // n'est pas écoulé (c'est l'appel lui-même qui crée une commande, tente TCP puis SMS, et
    // journalise). La RESTAURATION n'est jamais retardée — cf. CUT_BACKOFF_MS.
    if (action === EngineAction.CUT) {
      const retryAfter = this.cutRetryAfter.get(schedule.vehicleId);
      if (retryAfter && Date.now() < retryAfter) {
        // On continue de suivre le blocage : l'alerte « coupe impossible depuis X min » doit
        // toujours partir, même pendant qu'on espace les tentatives. On rapporte la DERNIÈRE
        // cause réelle — pas l'état d'attente, qui n'apprend rien à qui lit l'alerte.
        this.trackDeferral(schedule, this.lastFailureReason.get(schedule.vehicleId) ?? 'cause inconnue', true);
        return;
      }
    }

    this.logger.log(
      {
        vehicleId: schedule.vehicleId,
        trackerId: tracker.id,
        from: schedule.lastEvaluatedState,
        to: state,
        action,
      },
      `Schedule transition → ${action}`,
    );

    try {
      await this.engineControl.requestCommand(
        tracker.id,
        action,
        `Automatisation horaire : ${state === 'IN_WINDOW' ? 'entrée dans la plage autorisée' : 'sortie de la plage autorisée'}`,
        {
          userId: SCHEDULER_USER_ID,
          role: 'SUPER_ADMIN' as any, // bypass fleet check
          fleetId: null,
        },
        'SCHEDULER',
      );
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // REPORT (defer) : la commande ne peut pas s'appliquer MAINTENANT mais devra être
      // retentée — véhicule en mouvement, arrêt trop récent (règle 10 min CDEF), position
      // périmée/invalide, ou tracker hors ligne. Tous ces refus sont des ForbiddenException
      // (garde-fous de coupe) ou ServiceUnavailableException (dispatch impossible). On NE met
      // PAS à jour lastEvaluatedState → le prochain tick réessaiera. Ce n'est PAS une erreur
      // applicative : on log en warn, on n'alimente PAS le centre d'alertes.
      // Revue : on NE se fie QU'aux types. Tous les refus « report » réels sont soit un
      // ForbiddenException (garde-fous de coupe : vitesse, arrêt récent, fix, no-position) soit
      // un ServiceUnavailableException (dispatch impossible / hors ligne). Toute AUTRE erreur
      // (bug applicatif, panne Prisma, etc.) DOIT remonter (throw) pour alimenter le centre
      // d'alertes — les anciens tests `msg.includes(...)` pouvaient l'avaler par coïncidence de
      // sous-chaîne (ex. message contenant « position ») → coupe jamais appliquée, en silence.
      const isDeferrable =
        err instanceof ForbiddenException || err instanceof ServiceUnavailableException;
      if (isDeferrable) {
        // Mémorise la cause RÉELLE : les ticks suivants tombent dans le backoff et ne la
        // reverront pas, alors que c'est elle qu'il faut rapporter (cf. lastFailureReason).
        this.lastFailureReason.set(schedule.vehicleId, msg);
        // Suivi : si la coupe reste bloquée trop longtemps, on la remonte au centre d'alertes.
        this.trackDeferral(schedule, msg);
        // Une COUPE en échec est espacée ; une RESTAURATION est retentée au tick suivant.
        const nextIn = action === EngineAction.CUT ? this.scheduleCutRetry(schedule.vehicleId) : 0;
        this.logger.warn(
          { vehicleId: schedule.vehicleId, error: msg, action, retryInMin: nextIn / 60000 },
          nextIn > 0
            ? `Coupe reportée — nouvelle tentative dans ${Math.round(nextIn / 60000)} min`
            : 'Schedule action deferred (retry next tick)',
        );
        return;
      }
      throw err;
    }

    // Update last evaluated state — si ça échoue, le cron renverra la commande
    // au prochain tick (doublon côté device, mais cohérence garantie).
    try {
      await this.prisma.vehicleSchedule.update({
        where: { id: schedule.id },
        data: { lastEvaluatedAt: new Date(), lastEvaluatedState: state },
      });
    } catch (dbErr) {
      this.logger.error(
        { vehicleId: schedule.vehicleId, error: (dbErr as Error).message },
        'Failed to update lastEvaluatedState — next tick may resend command',
      );
      this.errorLogger.record(
        dbErr instanceof Error ? dbErr : new Error(String(dbErr)),
        'schedule-cron', { vehicleId: schedule.vehicleId, phase: 'state-update' },
      ).catch(() => {});
      return; // Ne pas persister l'history si le state n'a pas été mis à jour
    }

    // Action aboutie → la coupe/reprise n'est plus « bloquée » pour ce véhicule.
    this.clearDeferral(schedule.vehicleId);

    // Persister la transition dans schedule_history (audit + UI timeline)
    const occurredAt = new Date();
    await this.prisma.scheduleHistory.create({
      data: {
        scheduleId: schedule.id,
        vehicleId: schedule.vehicleId,
        action,
        reason: evaluation.reason,
        windowDesc: evaluation.windowDesc,
        occurredAt,
      },
    }).catch((e) => this.logger.warn(`schedule_history insert failed: ${(e as Error).message}`));

    try {
      const transitionEvent: ScheduleTransitionEvent = {
        scheduleId: schedule.id,
        vehicleId: schedule.vehicleId,
        fleetId: schedule.vehicle.fleetId,
        trackerId: tracker.id,
        action,
        reason: evaluation.reason,
        windowDesc: evaluation.windowDesc,
        occurredAt: occurredAt.toISOString(),
      };
      this.events.emit('schedule.transition', transitionEvent);
    } catch (evtErr) {
      this.logger.warn({ error: (evtErr as Error).message }, 'schedule.transition event emit failed');
    }
  }

  /**
   * Enregistre un report ; remonte UNE alerte (ré-espacée) si la coupe/reprise reste bloquée trop
   * longtemps. `waitingBackoff` indique qu'on est dans une fenêtre d'attente — la CAUSE rapportée
   * reste celle du dernier échec réel, l'attente n'étant qu'une précision de contexte.
   */
  private trackDeferral(schedule: ScheduleWithVehicle, reason: string, waitingBackoff = false): void {
    const vid = schedule.vehicleId;
    const now = Date.now();
    const since = this.deferredSince.get(vid) ?? now;
    this.deferredSince.set(vid, since);
    const stuckMs = now - since;
    if (stuckMs < STUCK_ALERT_MS) return;
    const lastAlert = this.lastStuckAlertAt.get(vid) ?? 0;
    if (now - lastAlert < STUCK_REALERT_MS) return;
    this.lastStuckAlertAt.set(vid, now);
    const minutes = Math.round(stuckMs / 60000);
    // Le véhicule est nommé par sa PLAQUE : une alerte qui ne porte qu'un UUID oblige à ouvrir la
    // base pour savoir de quel véhicule on parle (les alertes GPS, elles, nomment déjà la plaque).
    const who = schedule.vehicle.plate ? `${schedule.vehicle.plate} ` : '';
    this.errorLogger
      .record(
        new Error(`Automatisation horaire : coupe/reprise impossible sur ${who}depuis ${minutes} min — ${reason}`),
        'schedule-cron',
        {
          vehicleId: vid,
          plate: schedule.vehicle.plate ?? null,
          fleetId: schedule.vehicle.fleetId,
          stuckMinutes: minutes,
          cause: reason,
          waitingBackoff,
          phase: 'stuck-schedule-action',
        },
      )
      .catch(() => { /* best-effort */ });
  }

  /**
   * Trace la suspension dans les LOGS DU CONTENEUR — et nulle part ailleurs.
   *
   * ⚠️ N'ÉCRIT PLUS au centre d'alerte, et ce retrait est le correctif d'un vrai incident.
   *
   * Version précédente : une ligne ERROR au centre d'alerte, « une fois puis silence 7 j ».
   * Deux fautes de conception cumulées, constatées en production le 2026-07-28 (12 lignes
   * pour 2 véhicules en une soirée) :
   *
   *  1. L'anti-répétition était EN MÉMOIRE, pour un état qui dure des MOIS. Chaque
   *     redémarrage d'API la remettait à zéro — six déploiements dans la soirée, plus
   *     chaque smoke-boot jetable qui exécute un tick de cron avant de mourir. « Une fois
   *     par semaine » est devenu « deux lignes par redémarrage ».
   *  2. C'était classé ERREUR. Un planning suspendu sur un boîtier mort depuis 90 jours
   *     n'est pas une faute : c'est un ÉTAT stable, connu, et déjà exposé là où il est
   *     actionnable — `fleet-schedules.service` rend `presence: 'DORMANT'` par véhicule
   *     et compte les plannings concernés (`scheduledDormantCount`). Le centre d'alerte
   *     doit contenir des FAUTES, pas des états ; le dupliquer ici n'ajoutait rien et
   *     noyait les vraies erreurs.
   *
   * Leçon générale : un état stable se LIT (page dédiée), il ne se NOTIFIE pas en boucle.
   * Et un anti-répétition qui doit survivre plus longtemps qu'un processus n'a pas sa
   * place en mémoire.
   */
  private reportDormant(schedule: ScheduleWithVehicle, lastSeenAt: Date | null): void {
    const vid = schedule.vehicleId;
    const now = Date.now();
    const last = this.lastDormantAlertAt.get(vid) ?? 0;
    // Palier purement local aux logs : ils rotent, et personne ne les surveille en continu.
    if (now - last < DORMANT_REALERT_MS) return;
    this.lastDormantAlertAt.set(vid, now);
    this.logger.log(
      { vehicleId: vid, plate: schedule.vehicle.plate ?? null, silence: formatSilenceLabel(lastSeenAt) ?? 'toujours' },
      'Automatisation horaire suspendue (boîtier muet) — visible sur la page Horaires, pas au centre d\'alerte',
    );
  }

  /**
   * Arme le prochain essai de coupe et renvoie le délai appliqué (ms). Palier croissant borné :
   * on n'abandonne JAMAIS de couper, on arrête juste de marteler.
   */
  private scheduleCutRetry(vehicleId: string): number {
    const failures = (this.cutFailures.get(vehicleId) ?? 0) + 1;
    this.cutFailures.set(vehicleId, failures);
    const delay = CUT_BACKOFF_MS[Math.min(failures, CUT_BACKOFF_MS.length) - 1];
    this.cutRetryAfter.set(vehicleId, Date.now() + delay);
    return delay;
  }

  /** La coupe/reprise a abouti (ou n'est plus attendue) → on oublie le report ET le backoff. */
  private clearDeferral(vehicleId: string): void {
    this.deferredSince.delete(vehicleId);
    this.lastStuckAlertAt.delete(vehicleId);
    this.cutRetryAfter.delete(vehicleId);
    this.cutFailures.delete(vehicleId);
    this.lastFailureReason.delete(vehicleId);
  }

  /** Compute whether the current time is inside the allowed window. */
  computeState(schedule: VehicleSchedule): 'IN_WINDOW' | 'OUT_OF_WINDOW' {
    const now = getNowInTimezone(schedule.timezone);
    const dayIndex = now.getDay(); // 0=Sunday
    const dayName = DAYS[dayIndex];

    const enabled = (schedule as any)[`${dayName}Enabled`] as boolean;
    if (!enabled) return 'OUT_OF_WINDOW';

    const startStr = (schedule as any)[`${dayName}Start`] as string | null;
    const endStr = (schedule as any)[`${dayName}End`] as string | null;

    if (!startStr || !endStr) return 'IN_WINDOW'; // day enabled but no times → no restriction

    const [startH, startM] = startStr.split(':').map(Number);
    const [endH, endM] = endStr.split(':').map(Number);

    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (nowMinutes >= startMinutes && nowMinutes < endMinutes) {
      return 'IN_WINDOW';
    }

    return 'OUT_OF_WINDOW';
  }
}

/** Get current Date object adjusted to a timezone. */
function getNowInTimezone(timezone: string): Date {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '0';

  return new Date(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  );
}

interface ScheduleWithVehicle extends VehicleSchedule {
  vehicle: {
    id: string;
    fleetId: string;
    /** Optionnel dans le type (les fixtures de test ne la fournissent pas) mais TOUJOURS chargée
     *  en production : `evaluateAll` inclut le véhicule entier. Sert à nommer le véhicule en alerte. */
    plate?: string | null;
    tracker: {
      id: string;
      imei: string;
      status: string;
      /** Optionnel dans le type (fixtures de test) mais TOUJOURS chargé en production :
       *  `evaluateAll` inclut le tracker entier. Seule source de la dormance. */
      lastSeenAt?: Date | null;
    } | null;
  };
}
