import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { CommandStatus, EngineAction, type VehicleSchedule } from '@prisma/client';
import { DORMANT_STOP_ACTING_MS, formatSilenceLabel, trackerSilenceMs } from '@vizyo/tracky-shared';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { EngineControlService, PresumedParkedException } from '../engine-control/engine-control.service';
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

/** Période du cron (`@Cron` chaque minute) — sert de marge au réessai à échéance connue. */
const CRON_TICK_MS = 60 * 1000;

/**
 * TRK-029 — reconnaît, dans la CAUSE d'un report, un compte à rebours CALCULABLE :
 * « …arrêté depuis seulement N s (minimum requis M s) » (garde SCHEDULER d'engine-control).
 * Un backoff traite l'ignorance ; il ne doit pas traiter une échéance connue : ici le code
 * a la réponse (M − N secondes) dans la donnée qu'il vient d'évaluer.
 * ⚠️ Couplage textuel ASSUMÉ avec engine-control.service.ts (SCHEDULE_CUT_MIN_STOPPED_MS) :
 * si le libellé change, on retombe sur le backoff exponentiel — dégradation sûre, jamais fausse.
 */
const KNOWN_COUNTDOWN_RE = /arrêté depuis seulement (\d+)\s*s.*?minimum requis (\d+)\s*s/;

export function parseKnownCountdown(msg: string): { stoppedS: number; minS: number } | null {
  const m = KNOWN_COUNTDOWN_RE.exec(msg);
  if (!m) return null;
  return { stoppedS: Number(m[1]), minS: Number(m[2]) };
}

/** Ré-alerte « planning suspendu pour dormance » : hebdomadaire (l'état est stable). */
const DORMANT_REALERT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * TRK-046 — re-vérification d'un véhicule CONSIDÉRÉ STATIONNÉ (hors champ GPS dans un
 * parking validé). Ce n'est PAS un backoff d'échec : rien n'a échoué, on attend juste que
 * le véhicule ressorte. 10 min suffisent — la SORTIE, elle, est détectée à la trame près
 * par l'ingestion (alerte OFF_SCHEDULE_MOVEMENT), pas par ce cron.
 */
const PARKED_RECHECK_MS = 10 * 60 * 1000;
/** Journal « considéré stationné » : une ligne à l'entrée dans l'état, puis toutes les 6 h. */
const PARKED_RELOG_MS = 6 * 60 * 60 * 1000;

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
  /** TRK-029 — échéance CONNUE du prochain essai de coupe (réessai programmé, pas backoff). */
  private readonly cutRetryDeadline = new Map<string, { at: number; stoppedS: number; minS: number }>();
  /** TRK-029 — ids des lignes « différée/impossible » écrites, pour les CLORE à l'aboutissement. */
  private readonly stuckAlertLogIds = new Map<string, string[]>();
  /** Dernière alerte « planning suspendu pour dormance » par véhicule (anti-répétition). */
  private readonly lastDormantAlertAt = new Map<string, number>();
  /**
   * TRK-046 — véhicules CONSIDÉRÉS STATIONNÉS (hors champ GPS, parking validé) : instant
   * avant lequel on ne re-vérifie pas. Volontairement EN MÉMOIRE et sans conséquence
   * utilisateur : au pire un redémarrage coûte UN appel moteur de plus (qui re-répond
   * « stationné » sans rien écrire) — rien à voir avec les anti-répétitions d'ALERTE,
   * qui elles doivent survivre au processus (TRK-038).
   */
  private readonly parkedRecheckAfter = new Map<string, number>();
  /** Journal « considéré stationné » : dernière ligne écrite, pour espacer (PARKED_RELOG_MS). */
  private readonly lastParkedLogAt = new Map<string, number>();

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
    // ⚠️ Le `clearDeferral` est OBLIGATOIRE : sans lui, les Map de suivi (report, backoff,
    // compteur d'échecs, échéance connue, dernière cause, ids d'alerte) garderaient une
    // entrée par véhicule dormant indéfiniment — une fuite mémoire lente.
    const silentMs = trackerSilenceMs(tracker.lastSeenAt);
    if (silentMs != null && silentMs > DORMANT_STOP_ACTING_MS) {
      this.clearDeferral(schedule.vehicleId, 'planning suspendu (boîtier muet — dormance)');
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
    if (state === schedule.lastEvaluatedState) { this.clearDeferral(schedule.vehicleId, 'coupe devenue sans objet (planning revenu en phase)'); return; }

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
      // TRK-046 — véhicule considéré stationné (hors champ GPS, parking validé) : on attend
      // sa sortie SANS rien compter. Ni deferredSince, ni backoff, ni alerte : ce n'est pas
      // un échec, c'est un état. La sortie est surveillée par l'ingestion, pas par ce tick.
      const parkedUntil = this.parkedRecheckAfter.get(schedule.vehicleId);
      if (parkedUntil && Date.now() < parkedUntil) return;

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
      // ══ TRK-046 — CONSIDÉRÉ STATIONNÉ : un état, pas un échec ═══════════════════════════
      // Le véhicule est hors champ GPS dans un parking validé (souterrain/couvert). Décision
      // du propriétaire (25/08) : c'est le comportement NORMAL d'un GPS sous terre — aucune
      // alerte « coupe impossible », aucun backoff d'échec, et l'on CLÔT les lignes de
      // blocage antérieures (le véhicule n'est plus « bloqué », il est stationné). La sortie
      // hors horaire, elle, est détectée par l'ingestion → alerte OFF_SCHEDULE_MOVEMENT.
      // Discriminé par TYPE, jamais par texte (même revue que isDeferrable ci-dessous).
      if (err instanceof PresumedParkedException && action === EngineAction.CUT) {
        this.clearDeferral(schedule.vehicleId, 'véhicule considéré stationné (hors champ GPS, parking validé)');
        this.parkedRecheckAfter.set(schedule.vehicleId, Date.now() + PARKED_RECHECK_MS);
        const lastLog = this.lastParkedLogAt.get(schedule.vehicleId) ?? 0;
        if (Date.now() - lastLog >= PARKED_RELOG_MS) {
          this.lastParkedLogAt.set(schedule.vehicleId, Date.now());
          this.logger.log(
            { vehicleId: schedule.vehicleId, plate: schedule.vehicle.plate ?? null, detail: msg },
            'Coupe auto en veille : véhicule considéré stationné (hors champ GPS, parking validé) — sortie surveillée',
          );
        }
        return;
      }
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
        // Mémorise la cause RÉELLE : les ticks suivants tombent dans la fenêtre d'attente et
        // ne la reverront pas, alors que c'est elle qu'il faut rapporter (cf. lastFailureReason).
        this.lastFailureReason.set(schedule.vehicleId, msg);
        // TRK-029 — deux familles de report, deux traitements :
        //  • échéance CONNUE (« arrêté depuis N s, minimum M s ») → réessai programmé à M − N
        //    (+ un tick de marge) : le compte à rebours est lisible dans la cause elle-même,
        //    attendre un palier de backoff coûtait 25 min d'immobilisation mesurées (17/08) ;
        //  • cause inconnue ou panne de transport → backoff exponentiel (incident 2026-07-19) :
        //    le délai croissant traite l'ignorance, pas une échéance.
        // Une RESTAURATION n'est JAMAIS retardée (cf. CUT_BACKOFF_MS — asymétrie volontaire).
        const countdown = action === EngineAction.CUT ? parseKnownCountdown(msg) : null;
        let nextIn = 0;
        if (countdown) {
          nextIn = this.scheduleCutRetryAtDeadline(schedule.vehicleId, countdown);
        } else {
          // Cause sans échéance : l'éventuelle échéance mémorisée est périmée — la rédaction
          // d'alerte ne doit plus promettre un « réessai à HH:MM » qu'on ne tient plus.
          this.cutRetryDeadline.delete(schedule.vehicleId);
          if (action === EngineAction.CUT) nextIn = this.scheduleCutRetry(schedule.vehicleId);
        }
        // Suivi : si la coupe reste bloquée trop longtemps, on la remonte au centre d'alertes.
        // APRÈS l'armement du réessai : l'alerte émise sur le tick d'échec lui-même doit déjà
        // pouvoir dire « réessai à HH:MM » quand l'échéance est connue.
        this.trackDeferral(schedule, msg);
        this.logger.warn(
          { vehicleId: schedule.vehicleId, error: msg, action, retryInMin: nextIn / 60000, knownDeadline: countdown != null },
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
    this.clearDeferral(schedule.vehicleId, action === EngineAction.CUT ? 'coupe aboutie' : 'reprise aboutie');

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
   *
   * TRK-029 — deux rédactions, selon ce qu'on SAIT :
   *  • échéance connue → « coupe différée…, réessai à HH:MM » : l'attente est un choix, pas une
   *    panne. Un exploitant qui lit « impossible » appelle le conducteur ; celui qui lit
   *    « différée à 20:30 » attend.
   *  • cause inconnue → « impossible depuis N min — <cause> » (inchangé) : là, c'est vrai.
   * L'id de chaque ligne écrite est conservé pour que clearDeferral() la CLÔTURE — une alerte
   * sans état de sortie reste vraie pour toujours (le centre d'alerte a gardé un « impossible »
   * décrivant une coupe qui avait abouti 24 minutes plus tard).
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
    const deadline = this.cutRetryDeadline.get(vid);
    let headline: string;
    if (deadline) {
      // HH:MM dans le fuseau du planning : c'est l'heure que l'exploitant a sous les yeux.
      let retryAtLocal: string;
      try {
        retryAtLocal = new Intl.DateTimeFormat('fr-FR', {
          timeZone: schedule.timezone, hour: '2-digit', minute: '2-digit',
        }).format(new Date(deadline.at));
      } catch {
        retryAtLocal = `${new Date(deadline.at).toISOString().slice(11, 16)} UTC`;
      }
      headline =
        `Automatisation horaire : coupe différée sur ${who}depuis ${minutes} min, ` +
        `réessai à ${retryAtLocal} — véhicule arrêté depuis ${deadline.stoppedS} s sur ${deadline.minS} s requis`;
    } else {
      headline = `Automatisation horaire : coupe/reprise impossible sur ${who}depuis ${minutes} min — ${reason}`;
    }
    this.errorLogger
      .record(
        new Error(headline),
        'schedule-cron',
        {
          vehicleId: vid,
          plate: schedule.vehicle.plate ?? null,
          fleetId: schedule.vehicle.fleetId,
          stuckMinutes: minutes,
          cause: reason,
          waitingBackoff,
          knownDeadline: !!deadline,
          deferredUntil: deadline ? new Date(deadline.at).toISOString() : null,
          phase: 'stuck-schedule-action',
        },
      )
      .then((id) => {
        // Ne garder que de VRAIS ids : ErrorLogger renvoie des sentinelles ('deduped',
        // 'transient', 'already-recorded', 'persist-failed') quand rien n'a été écrit.
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          const ids = this.stuckAlertLogIds.get(vid) ?? [];
          ids.push(id);
          this.stuckAlertLogIds.set(vid, ids);
        }
      })
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

  /**
   * TRK-029 — réessai à l'échéance CONNUE. « Arrêté depuis N s, minimum M s » n'est pas une
   * incertitude : c'est un compte à rebours de M − N secondes, lisible dans la donnée qui vient
   * d'être évaluée. Le tick de marge n'est pas décoratif : la fenêtre du garde est bornée par
   * `gte` et N est arrondi à la seconde — un essai qui tombe PILE sur l'échéance serait
   * re-différé pour rien.
   * ⚠️ Ne touche PAS au compteur d'échecs : les paliers exponentiels (CUT_BACKOFF_MS) restent
   * réservés aux pannes de transport et aux causes inconnues — c'est là qu'ils sont justifiés.
   */
  private scheduleCutRetryAtDeadline(vehicleId: string, countdown: { stoppedS: number; minS: number }): number {
    const delay = Math.max(0, countdown.minS - countdown.stoppedS) * 1000 + CRON_TICK_MS;
    const at = Date.now() + delay;
    this.cutRetryAfter.set(vehicleId, at);
    this.cutRetryDeadline.set(vehicleId, { at, stoppedS: countdown.stoppedS, minS: countdown.minS });
    return delay;
  }

  /**
   * La coupe/reprise a abouti (ou n'est plus attendue) → on oublie le report ET le backoff,
   * et l'on CLÔT les lignes d'alerte écrites pendant le blocage (TRK-029 : une alerte sans
   * état de sortie reste vraie pour toujours). Champ de résolution sur la ligne d'origine —
   * `resolvedAt`/`resolvedNote` existent depuis l'archivage réversible du 22/08.
   * `resolvedAt: null` dans le where : on n'écrase JAMAIS une résolution posée par un humain.
   * Fire-and-forget assumé : la clôture est un confort de lecture, pas un invariant — elle ne
   * doit ni retarder ni faire échouer le tick.
   */
  private clearDeferral(vehicleId: string, outcome = 'coupe/reprise plus attendue'): void {
    const alertIds = this.stuckAlertLogIds.get(vehicleId);
    if (alertIds?.length) {
      this.prisma.errorLog
        .updateMany({
          where: { id: { in: alertIds }, resolvedAt: null },
          data: { resolvedAt: new Date(), resolvedNote: `Clôture automatique (schedule-cron) : ${outcome}.` },
        })
        .catch((e: unknown) => this.logger.warn(`Clôture d'alertes de coupe échouée : ${(e as Error).message}`));
    }
    this.stuckAlertLogIds.delete(vehicleId);
    this.deferredSince.delete(vehicleId);
    this.lastStuckAlertAt.delete(vehicleId);
    this.cutRetryAfter.delete(vehicleId);
    this.cutFailures.delete(vehicleId);
    this.cutRetryDeadline.delete(vehicleId);
    this.lastFailureReason.delete(vehicleId);
    // TRK-046 — l'état « considéré stationné » se referme avec le reste : une coupe aboutie,
    // une reprise ou un planning revenu en phase rendent la présomption sans objet. (La
    // branche stationné re-pose son entrée juste APRÈS avoir appelé clearDeferral.)
    this.parkedRecheckAfter.delete(vehicleId);
    this.lastParkedLogAt.delete(vehicleId);
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
