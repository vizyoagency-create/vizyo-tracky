import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TrackerCommandStatus, UserRole } from '@prisma/client';
import type { TrackerCommand } from '@prisma/client';
import { findTemplate, COBAN_COMMAND_CATALOG } from '@vizyo/tracky-shared';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { resolveTenantScope } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { AckWaiterService } from './ack-waiter.service';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

@Injectable()
export class TrackerCommandsService {
  private readonly logger = new Logger(TrackerCommandsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SocketRegistryService,
    private readonly ackWaiter: AckWaiterService,
    private readonly wireLogger: CobanWireLogger,
    private readonly gateway: RealtimeGateway,
  ) {}

  async request(
    trackerId: string,
    templateId: string,
    params: Record<string, unknown>,
    scheduledAt: Date | null,
    requestedBy: RequestedBy,
  ): Promise<TrackerCommand> {
    if (templateId === 'engine_stop' || templateId === 'engine_resume') {
      throw new BadRequestException(
        'Les commandes moteur sont exclusives à /engine-control. Utilisez le bouton dédié.',
      );
    }

    const template = findTemplate(templateId);
    if (!template) {
      throw new BadRequestException(`Template inconnu: ${templateId}`);
    }

    if (template.requiresSuperAdmin && requestedBy.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cette commande nécessite le rôle SUPER_ADMIN');
    }

    const tracker = await this.prisma.tracker.findUnique({
      where: { id: trackerId },
      include: { vehicle: true },
    });
    if (!tracker) throw new NotFoundException('Tracker introuvable');
    if (!tracker.vehicle) throw new BadRequestException('Tracker non associé à un véhicule');

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (tracker.vehicle.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Accès refusé à cette flotte');
      }
    }

    // Validate params
    for (const spec of template.params) {
      if (spec.required && (params[spec.name] === undefined || params[spec.name] === '')) {
        throw new BadRequestException(`Paramètre requis manquant: ${spec.name}`);
      }
      if (spec.validate && params[spec.name] !== undefined) {
        const err = spec.validate(params[spec.name]);
        if (err) throw new BadRequestException(`${spec.name}: ${err}`);
      }
    }

    const payload = template.buildPayload(tracker.imei, params);

    const command = await this.prisma.trackerCommand.create({
      data: {
        trackerId,
        templateId,
        category: template.category,
        params: params as any,
        payload,
        status: scheduledAt ? TrackerCommandStatus.SCHEDULED : TrackerCommandStatus.PENDING,
        scheduledAt,
        requestedBy: requestedBy.userId,
      },
    });

    this.logger.log(
      { commandId: command.id, imei: tracker.imei, templateId, payload },
      'Command created',
    );

    if (!scheduledAt) {
      await this.dispatch(command, tracker.imei, tracker.vehicle.fleetId);
    }

    return command;
  }

  /**
   * Envoie une commande au tracker via TCP.
   *
   * Securite : `imei` et `fleetId` sont fournis par le caller, qui est
   * responsable d'avoir valide le tenant en amont (recuperer le tracker via
   * une route qui applique le filtre tenant, puis passer ses champs). On
   * evite ainsi un lookup tracker.id non scope qui pourrait reveler des
   * donnees cross-fleet via un commandId enumere.
   *
   * `fleetId` accepte `null` pour les trackers orphelins (sans vehicle attache,
   * ex: provisioning) — dans ce cas le broadcast WS est skip.
   */
  async dispatch(command: TrackerCommand, imei: string, fleetId: string | null): Promise<void> {
    const resolvedImei = imei;
    const resolvedFleetId = fleetId ?? '';

    // #20 — passe par registry.send() (verifie destroyed + writable + try/catch +
    // nettoie l'entree morte) au lieu d'ecrire directement sur la socket : une
    // socket demi-morte ne doit pas etre marquee SENT en laissant fuiter l'entree.
    const sentOk = this.registry.send(resolvedImei, command.payload);
    if (!sentOk) {
      await this.prisma.trackerCommand.update({
        where: { id: command.id },
        data: { status: TrackerCommandStatus.FAILED, lastError: 'Tracker offline' },
      });
      this.emitUpdate(command.id, resolvedFleetId);
      throw new ServiceUnavailableException('Tracker hors ligne, commande non envoyée');
    }

    // #36 — capture sentAt localement (l'objet `command` en memoire n'est PAS mis
    // a jour par le prisma.update) pour calculer une vraie latence d'ACK plus bas.
    const sentAt = new Date();
    await this.prisma.trackerCommand.update({
      where: { id: command.id },
      data: { status: TrackerCommandStatus.SENT, sentAt },
    });

    this.wireLogger.out(resolvedImei, command.payload, {
      commandId: command.id,
      source: 'tracker-cmd',
    });

    this.emitUpdate(command.id, resolvedFleetId);

    // Background ACK wait
    const template = findTemplate(command.templateId);
    if (template && template.expectedAckPattern) {
      this.ackWaiter
        .waitForAck(resolvedImei, template.expectedAckPattern, template.ackTimeoutMs, command.id)
        .then(async (rawAck) => {
          const latencyMs = Date.now() - sentAt.getTime();
          this.wireLogger.ackMatch(resolvedImei, rawAck, command.id, latencyMs);
          await this.prisma.trackerCommand.update({
            where: { id: command.id },
            data: {
              status: TrackerCommandStatus.ACKNOWLEDGED,
              ackedAt: new Date(),
              ackResponse: rawAck,
            },
          });
          this.emitUpdate(command.id, resolvedFleetId);
        })
        .catch(async (err) => {
          this.wireLogger.ackTimeout(
            resolvedImei,
            command.id,
            template.expectedAckPattern.source,
            template.ackTimeoutMs,
          );
          await this.prisma.trackerCommand.update({
            where: { id: command.id },
            data: {
              status: TrackerCommandStatus.FAILED,
              lastError: `ACK timeout: ${(err as Error).message}`,
            },
          });
          this.emitUpdate(command.id, resolvedFleetId);
        });
    }
  }

  async cancel(commandId: string, requestedBy: RequestedBy): Promise<TrackerCommand> {
    const command = await this.prisma.trackerCommand.findUnique({
      where: { id: commandId },
      include: { tracker: { include: { vehicle: true } } },
    });

    if (!command) throw new NotFoundException('Commande introuvable');

    if (
      command.status !== TrackerCommandStatus.PENDING &&
      command.status !== TrackerCommandStatus.SCHEDULED
    ) {
      throw new BadRequestException('Seules les commandes PENDING ou SCHEDULED peuvent être annulées');
    }

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      const fleetId = (command as any).tracker?.vehicle?.fleetId;
      if (fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Accès refusé');
      }
    }

    return this.prisma.trackerCommand.update({
      where: { id: commandId },
      data: { status: TrackerCommandStatus.CANCELLED },
    });
  }

  async list(
    requestedBy: RequestedBy,
    filters?: {
      trackerId?: string;
      status?: TrackerCommandStatus;
      category?: string;
      limit?: number;
    },
  ): Promise<TrackerCommand[]> {
    const limit = Math.min(filters?.limit ?? 50, 200);
    const where: Record<string, unknown> = {};

    // V1.16 (audit D9) — fail-closed : non-super sans fleetId => aucun resultat.
    const scope = resolveTenantScope(requestedBy);
    if (scope.mode === 'DENY') return [];
    if (scope.mode === 'FLEET') {
      where.tracker = { vehicle: { fleetId: scope.fleetId } };
    }

    if (filters?.trackerId) where.trackerId = filters.trackerId;
    if (filters?.status) where.status = filters.status;
    if (filters?.category) where.category = filters.category;

    return this.prisma.trackerCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { requestedByUser: { select: { email: true, firstName: true, lastName: true } } },
    });
  }

  async getCommand(id: string, requestedBy: RequestedBy): Promise<TrackerCommand> {
    const command = await this.prisma.trackerCommand.findUnique({
      where: { id },
      include: {
        tracker: { include: { vehicle: true } },
        requestedByUser: { select: { email: true, firstName: true, lastName: true } },
      },
    });

    if (!command) throw new NotFoundException('Commande introuvable');

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      const fleetId = (command as any).tracker?.vehicle?.fleetId;
      if (fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Accès refusé');
      }
    }

    return command;
  }

  getCatalog(role: UserRole) {
    return COBAN_COMMAND_CATALOG.filter((t) => {
      if (t.requiresSuperAdmin && role !== UserRole.SUPER_ADMIN) return false;
      return true;
    }).map((t) => ({
      id: t.id,
      category: t.category,
      label: t.label,
      description: t.description,
      dangerous: t.dangerous,
      requiresConfirmation: t.requiresConfirmation,
      requiresSuperAdmin: t.requiresSuperAdmin,
      params: t.params.map((p) => ({
        name: p.name,
        label: p.label,
        type: p.type,
        required: p.required,
        min: p.min,
        max: p.max,
        options: p.options,
      })),
      availableVia: t.availableVia,
      ackTimeoutMs: t.ackTimeoutMs,
    }));
  }

  private emitUpdate(commandId: string, fleetId: string): void {
    if (!fleetId) return;
    this.gateway.server
      ?.to(`fleet:${fleetId}`)
      .to('fleet:*')
      .emit('tracker-command:updated', { commandId });
  }
}
