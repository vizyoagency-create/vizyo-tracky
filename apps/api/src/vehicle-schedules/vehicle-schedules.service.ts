import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EngineAction, UserRole } from '@prisma/client';
import type { VehicleSchedule } from '@prisma/client';
import { EngineControlService } from '../engine-control/engine-control.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UpsertVehicleScheduleDto } from './dto/upsert-vehicle-schedule.dto';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

@Injectable()
export class VehicleSchedulesService {
  private readonly logger = new Logger(VehicleSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engineControl: EngineControlService,
  ) {}

  async get(vehicleId: string, requestedBy: RequestedBy): Promise<VehicleSchedule | null> {
    await this.assertAccess(vehicleId, requestedBy);
    return this.prisma.vehicleSchedule.findUnique({ where: { vehicleId } });
  }

  async upsert(
    vehicleId: string,
    dto: UpsertVehicleScheduleDto,
    requestedBy: RequestedBy,
  ): Promise<VehicleSchedule> {
    await this.assertAccess(vehicleId, requestedBy);

    // If enabling, verify vehicle has a tracker
    if (dto.enabled) {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        include: { tracker: true },
      });
      if (!vehicle?.tracker) {
        throw new BadRequestException(
          'Impossible d\'activer le scheduling : aucun tracker assigné',
        );
      }
    }

    // Detect transition enabled=true → false
    const existing = await this.prisma.vehicleSchedule.findUnique({
      where: { vehicleId },
    });
    const wasEnabled = existing?.enabled ?? false;
    const willBeEnabled = dto.enabled;
    const wasCut = existing?.lastEvaluatedState === 'OUT_OF_WINDOW';

    // Reset lastEvaluatedState when disabling (clean slate for next activation)
    const updateData = wasEnabled && !willBeEnabled
      ? { ...dto, lastEvaluatedState: null, lastEvaluatedAt: null }
      : dto;

    const updated = await this.prisma.vehicleSchedule.upsert({
      where: { vehicleId },
      create: { vehicleId, ...dto },
      update: updateData,
    });

    // If we just disabled AND the scheduler had CUT the vehicle → emit RESTORE
    if (wasEnabled && !willBeEnabled && wasCut) {
      const tracker = await this.prisma.tracker.findFirst({
        where: { vehicleId },
      });
      if (tracker) {
        this.logger.log(
          { vehicleId, trackerId: tracker.id },
          'Scheduler disabled while vehicle was cut → emitting RESTORE',
        );
        try {
          await this.engineControl.requestCommand(
            tracker.id,
            EngineAction.RESTORE,
            'Automatisation horaire désactivée',
            requestedBy,
            'MANUAL',
          );
        } catch (err) {
          this.logger.warn(
            { vehicleId, error: (err as Error).message },
            'Failed to emit RESTORE on scheduler disable (tracker may be offline)',
          );
        }
      }
    }

    return updated;
  }

  private async assertAccess(vehicleId: string, requestedBy: RequestedBy): Promise<void> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { fleetId: true },
    });

    if (!vehicle) {
      throw new NotFoundException('Véhicule introuvable');
    }

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (vehicle.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Accès refusé à cette flotte');
      }
    }
  }
}
