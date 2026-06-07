import {
  BadRequestException,
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
import { AckWaiterService } from '../tracker-commands/ack-waiter.service';

const STALE_THRESHOLD_MOVING_MS = 60 * 1000; // position fraîche exigée si véhicule roulait
const REST_SPEED_KMH = 5; // en-dessous = véhicule à l'arrêt, pas de seuil stale
const MAX_SPEED_FOR_CUT = 20;
const ENGINE_ACK_TIMEOUT_MS = 15_000;
const ENGINE_STOP_ACK_PATTERN = /imei:\d{15},J/i;
const ENGINE_RESUME_ACK_PATTERN = /imei:\d{15},K/i;

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

    if (action === EngineAction.CUT) {
      const lastPosition = await this.prisma.position.findFirst({
        where: { trackerId },
        orderBy: { timestamp: 'desc' },
      });

      if (!lastPosition) {
        const cmd = await this.prisma.engineControlCommand.create({
          data: {
            trackerId,
            action,
            reason,
            requestedBy: requestedBy.userId,
            source,
            status: CommandStatus.REJECTED_SPEED,
            lastError: 'Aucune position connue pour ce tracker',
          },
        });
        this.emitUpdate(cmd, fleetId);
        this.logger.warn(`Command ${cmd.id} REJECTED: aucune position connue`);
        throw new ForbiddenException('Aucune position connue pour ce tracker');
      }

      const ageMs = Date.now() - lastPosition.timestamp.getTime();
      // À l'arrêt (≤5 km/h) → pas de seuil stale, le véhicule est garé sans risque.
      // En mouvement → position fraîche exigée pour confirmer la vitesse actuelle.
      const isAtRest = lastPosition.speedKmh <= REST_SPEED_KMH;

      if (!isAtRest && ageMs > STALE_THRESHOLD_MOVING_MS) {
        const cmd = await this.prisma.engineControlCommand.create({
          data: {
            trackerId,
            action,
            reason,
            requestedBy: requestedBy.userId,
            status: CommandStatus.REJECTED_SPEED,
            source,
            lastError: `Position trop ancienne (${Math.round(ageMs / 1000)}s, seuil ${Math.round(STALE_THRESHOLD_MOVING_MS / 1000)}s)`,
          },
        });
        this.emitUpdate(cmd, fleetId);
        this.logger.warn(`Command ${cmd.id} REJECTED: position stale (${ageMs}ms, threshold ${STALE_THRESHOLD_MOVING_MS}ms)`);
        throw new ForbiddenException('Position trop ancienne (stale)');
      }

      if (!lastPosition.valid) {
        const cmd = await this.prisma.engineControlCommand.create({
          data: {
            trackerId,
            action,
            reason,
            requestedBy: requestedBy.userId,
            status: CommandStatus.REJECTED_SPEED,
            source,
            lastError: 'Fix GPS invalide',
          },
        });
        this.emitUpdate(cmd, fleetId);
        this.logger.warn(`Command ${cmd.id} REJECTED: fix GPS invalide`);
        throw new ForbiddenException('Fix GPS invalide');
      }

      if (lastPosition.speedKmh > MAX_SPEED_FOR_CUT) {
        const cmd = await this.prisma.engineControlCommand.create({
          data: {
            trackerId,
            action,
            reason,
            requestedBy: requestedBy.userId,
            status: CommandStatus.REJECTED_SPEED,
            source,
            lastError: `Vitesse trop élevée : ${lastPosition.speedKmh} km/h`,
          },
        });
        this.emitUpdate(cmd, fleetId);
        this.logger.warn(`Command ${cmd.id} REJECTED: vitesse ${lastPosition.speedKmh} km/h`);
        throw new ForbiddenException(`Vitesse trop élevée : ${lastPosition.speedKmh} km/h`);
      }
    }

    // If manual action → neutralize schedule to avoid conflict
    if (source === 'MANUAL') {
      const vehicle = tracker.vehicle;
      if (vehicle) {
        try {
          if (disableSchedule) {
            // Désactiver complètement le schedule (l'utilisateur a confirmé)
            await this.prisma.vehicleSchedule.updateMany({
              where: { vehicleId: vehicle.id, enabled: true },
              data: { enabled: false, lastEvaluatedState: null, lastEvaluatedAt: null },
            });
            this.logger.log({ vehicleId: vehicle.id }, 'Schedule disabled by manual engine command');
          } else {
            // Juste poser un override temporaire (1h)
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
      },
    });

    if (command.status === CommandStatus.PENDING) {
      await this.dispatchCommand(tracker.imei, command, action, fleetId);
    }

    return command;
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
      .waitForAck(imei, ackPattern, ENGINE_ACK_TIMEOUT_MS, command.id)
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
