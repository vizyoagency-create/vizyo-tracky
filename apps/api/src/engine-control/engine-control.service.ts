import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CommandStatus, EngineAction, Prisma, UserRole } from '@prisma/client';
import type { EngineControlCommand } from '@prisma/client';
import type { CobanCommand } from '@vizyo/tracky-shared';
import { encodeCommand } from '@vizyo/tracky-shared';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { resolveTenantScope } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { AckWaiterService } from '../tracker-commands/ack-waiter.service';

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

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

@Injectable()
export class EngineControlService {
  private readonly logger = new Logger(EngineControlService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionRegistry: SocketRegistryService,
    private readonly wireLogger: CobanWireLogger,
    private readonly ackWaiter: AckWaiterService,
    private readonly gateway: RealtimeGateway,
    private readonly errorLogger: ErrorLogger,
    private readonly sms: SmsGatewayService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  async requestCommand(
    trackerId: string,
    action: EngineAction,
    reason: string | null,
    requestedBy: RequestedBy,
    source: 'MANUAL' | 'SCHEDULER' = 'MANUAL',
    disableSchedule?: boolean,
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

      if (!isAtRest && ageMs > STALE_THRESHOLD_MOVING_MS) {
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
        if (lastPosition.speedKmh > REST_SPEED_KMH) {
          await reject(`Véhicule en mouvement (${lastPosition.speedKmh} km/h) — coupure réservée à l'arrêt`);
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
          await reject(
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

    // If manual action → neutralize schedule to avoid conflict
    if (source === 'MANUAL') {
      const vehicle = tracker.vehicle;
      if (vehicle) {
        const isWatchman = requestedBy.role === UserRole.NIGHT_WATCHMAN;
        // Sprint 3 (revue A1) — le veilleur (NIGHT_WATCHMAN) ne gère PAS les plannings (gate
        // `schedules_manage`) : on NE désactive JAMAIS le planning sur sa demande, même si
        // `disableSchedule:true` est forcé dans le body (sinon le gate horaires serait contourné
        // via la commande moteur).
        const mayDisableSchedule = disableSchedule && !isWatchman;
        try {
          if (mayDisableSchedule) {
            // Désactiver complètement le schedule (admin avec schedules_manage, confirmé)
            await this.prisma.vehicleSchedule.updateMany({
              where: { vehicleId: vehicle.id, enabled: true },
              data: { enabled: false, lastEvaluatedState: null, lastEvaluatedAt: null },
            });
            this.logger.log({ vehicleId: vehicle.id }, 'Schedule disabled by manual engine command');
          } else if (isWatchman && action === EngineAction.CUT) {
            // Sprint 3 (Option A) — coupe veilleur = intervention sécu de nuit : elle tient
            // JUSQU'À RÉACTIVATION MANUELLE. On suspend le planning sans échéance (override
            // « indéfini ») : le scheduler ne peut pas rallumer le véhicule au bout d'1h. Le
            // planning reste `enabled` ; un RESTORE reposera la grâce 1h normale (branche else).
            await this.prisma.vehicleSchedule.updateMany({
              where: { vehicleId: vehicle.id, enabled: true },
              data: { overrideUntil: WATCHMAN_HOLD_UNTIL },
            });
            this.logger.log({ vehicleId: vehicle.id }, 'Watchman cut — schedule held until manual restore');
          } else {
            // Override temporaire 1h : coupe admin sans disable, OU tout RESTORE (grâce après
            // réactivation manuelle → le scheduler reprend la main au bout d'1h).
            await this.prisma.vehicleSchedule.updateMany({
              where: { vehicleId: vehicle.id, enabled: true },
              data: { overrideUntil: new Date(Date.now() + 60 * 60 * 1000) },
            });
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
      if (smsSent) {
        const updated = await this.prisma.engineControlCommand.update({
          where: { id: command.id },
          data: { status: CommandStatus.SENT, sentAt: new Date(), lastError: 'Envoyé via SMS (TCP indisponible)' },
        });
        this.emitUpdate(updated, fleetId);
        this.logger.log({ commandId: command.id, imei, channel: 'SMS' }, 'Command dispatched via SMS fallback');
        return;
      }

      const updated = await this.prisma.engineControlCommand.update({
        where: { id: command.id },
        data: {
          status: CommandStatus.FAILED,
          lastError: 'Tracker offline — socket TCP indisponible et fallback SMS impossible (pas de simPhoneNumber)',
        },
      });
      this.emitUpdate(updated, fleetId);
      this.errorLogger.record(
        'Engine command dispatch failed: socket unavailable + no SMS fallback',
        'engine-control',
        { imei, commandId: command.id },
      ).catch((e) => this.logger.error('ErrorLogger persist failed', e));
      throw new ServiceUnavailableException('Tracker hors ligne, commande non envoyée');
    }

    this.wireLogger.out(imei, payload, { commandId: command.id, source: 'engine' });
    this.logger.log({ commandId: command.id, imei, payload }, 'Command dispatched');

    const updated = await this.prisma.engineControlCommand.update({
      where: { id: command.id },
      data: { status: CommandStatus.SENT, sentAt: new Date() },
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
        void this.reportIfUnconfirmed(command.id, imei);
      }, ENGINE_CONFIRM_WINDOW_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  /** Sprint 2 (Obj 5) — trace une coupure confirmable restée non confirmée. */
  private async reportIfUnconfirmed(commandId: string, imei: string): Promise<void> {
    const cmd = await this.prisma.engineControlCommand
      .findUnique({ where: { id: commandId }, select: { status: true, ackedAt: true, trackerId: true } })
      .catch(() => null);
    if (!cmd || cmd.status !== CommandStatus.SENT || cmd.ackedAt) return;
    this.logger.warn({ commandId, imei, trackerId: cmd.trackerId }, 'Engine CUT non confirmée dans la fenêtre');
    this.errorLogger
      .record('Coupure moteur non confirmée (pas de chute ignition dans la fenêtre)', 'engine-control', {
        commandId,
        imei,
        trackerId: cmd.trackerId,
        windowMs: ENGINE_CONFIRM_WINDOW_MS,
      })
      .catch((e) => this.logger.error('ErrorLogger persist failed', e));
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
  private async trySmsFallback(imei: string, action: EngineAction, commandId: string): Promise<boolean> {
    if (!this.sms.isEnabled()) return false;
    const tracker = await this.prisma.tracker.findFirst({
      where: { imei },
      select: { simPhoneNumber: true },
    });
    if (!tracker?.simPhoneNumber) return false;
    const smsPayload = action === EngineAction.CUT ? 'stop123456' : 'resume123456';
    const result = await this.sms.send(tracker.simPhoneNumber, smsPayload, {
      imei,
      commandId,
      source: 'engine-control-fallback',
    });
    return result.ok;
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
