import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { CommandStatus, EngineAction, type VehicleSchedule } from '@prisma/client';
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

    // No change → skip
    if (state === schedule.lastEvaluatedState) return;

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
      return;
    }

    const action =
      state === 'IN_WINDOW' ? EngineAction.RESTORE : EngineAction.CUT;

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
      // REJECTED_SPEED = vehicle is moving → retry on next tick (don't update state)
      if (msg.includes('Vitesse') || msg.includes('speed') || msg.includes('stale') || msg.includes('position')) {
        this.logger.warn(
          { vehicleId: schedule.vehicleId, error: msg },
          'Schedule action deferred (speed guard)',
        );
        return;
      }
      // Tracker offline → don't update state, retry later
      if (msg.includes('hors ligne') || msg.includes('offline')) {
        this.logger.warn(
          { vehicleId: schedule.vehicleId, error: msg },
          'Schedule action deferred (tracker offline)',
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
    tracker: { id: string; imei: string; status: string } | null;
  };
}
