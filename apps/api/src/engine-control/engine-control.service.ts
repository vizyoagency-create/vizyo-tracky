import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CommandStatus, EngineAction, UserRole } from '@prisma/client';
import type { EngineControlCommand } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const STALE_THRESHOLD_MS = 2 * 60 * 1000;
const MAX_SPEED_FOR_CUT = 20;

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

@Injectable()
export class EngineControlService {
  private readonly logger = new Logger(EngineControlService.name);

  constructor(private readonly prisma: PrismaService) {}

  async requestCommand(
    trackerId: string,
    action: EngineAction,
    reason: string | null,
    requestedBy: RequestedBy,
  ): Promise<EngineControlCommand> {
    const tracker = await this.prisma.tracker.findUnique({
      where: { id: trackerId },
      include: { vehicle: { include: { fleet: true } } },
    });

    if (!tracker) {
      throw new NotFoundException('Tracker introuvable');
    }

    if (!tracker.vehicle) {
      throw new BadRequestException('Tracker non associé à un véhicule');
    }

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (tracker.vehicle.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Accès refusé à cette flotte');
      }
    }

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
            status: CommandStatus.REJECTED_SPEED,
            lastError: 'Aucune position connue pour ce tracker',
          },
        });
        this.logger.warn(`Command ${cmd.id} REJECTED: aucune position connue`);
        throw new ForbiddenException('Aucune position connue pour ce tracker');
      }

      const ageMs = Date.now() - lastPosition.timestamp.getTime();
      if (ageMs > STALE_THRESHOLD_MS) {
        const cmd = await this.prisma.engineControlCommand.create({
          data: {
            trackerId,
            action,
            reason,
            requestedBy: requestedBy.userId,
            status: CommandStatus.REJECTED_SPEED,
            lastError: 'Position trop ancienne (stale)',
          },
        });
        this.logger.warn(`Command ${cmd.id} REJECTED: position stale (${ageMs}ms)`);
        throw new ForbiddenException('Position trop ancienne (stale)');
      }

      if (lastPosition.speedKmh > MAX_SPEED_FOR_CUT) {
        const cmd = await this.prisma.engineControlCommand.create({
          data: {
            trackerId,
            action,
            reason,
            requestedBy: requestedBy.userId,
            status: CommandStatus.REJECTED_SPEED,
            lastError: `Vitesse trop élevée : ${lastPosition.speedKmh} km/h`,
          },
        });
        this.logger.warn(`Command ${cmd.id} REJECTED: vitesse ${lastPosition.speedKmh} km/h`);
        throw new ForbiddenException(`Vitesse trop élevée : ${lastPosition.speedKmh} km/h`);
      }
    }

    const command = await this.prisma.engineControlCommand.create({
      data: {
        trackerId,
        action,
        reason,
        requestedBy: requestedBy.userId,
        status: CommandStatus.PENDING,
      },
    });

    this.logger.warn(
      `TODO: dispatch command ${command.id} to BullMQ worker when Coban protocol is implemented`,
    );

    return command;
  }

  async listCommands(
    requestedBy: RequestedBy,
    filters?: { trackerId?: string; status?: CommandStatus; limit?: number },
  ): Promise<EngineControlCommand[]> {
    const limit = Math.min(filters?.limit ?? 50, 50);

    const where: Record<string, unknown> = {};

    if (requestedBy.role !== UserRole.SUPER_ADMIN && requestedBy.fleetId) {
      where.tracker = { vehicle: { fleetId: requestedBy.fleetId } };
    }

    if (filters?.trackerId) where.trackerId = filters.trackerId;
    if (filters?.status) where.status = filters.status;

    return this.prisma.engineControlCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getCommand(id: string, requestedBy: RequestedBy): Promise<EngineControlCommand> {
    const command = await this.prisma.engineControlCommand.findUnique({
      where: { id },
      include: { tracker: { include: { vehicle: true } } },
    });

    if (!command) {
      throw new NotFoundException('Commande introuvable');
    }

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      const fleetId = (command as any).tracker?.vehicle?.fleetId;
      if (fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Accès refusé à cette commande');
      }
    }

    return command;
  }
}
