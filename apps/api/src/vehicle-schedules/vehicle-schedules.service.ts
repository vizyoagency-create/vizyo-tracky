import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { VehicleSchedule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { UpsertVehicleScheduleDto } from './dto/upsert-vehicle-schedule.dto';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

@Injectable()
export class VehicleSchedulesService {
  constructor(private readonly prisma: PrismaService) {}

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

    return this.prisma.vehicleSchedule.upsert({
      where: { vehicleId },
      create: { vehicleId, ...dto },
      update: dto,
    });
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
