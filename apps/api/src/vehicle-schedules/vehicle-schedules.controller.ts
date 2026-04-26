import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertVehicleScheduleDto } from './dto/upsert-vehicle-schedule.dto';
import { VehicleSchedulesService } from './vehicle-schedules.service';

@Controller('vehicles/:vehicleId/schedule')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VehicleSchedulesController {
  constructor(
    private readonly schedules: VehicleSchedulesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  get(
    @Param('vehicleId') vehicleId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.schedules.get(vehicleId, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Put()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  upsert(
    @Param('vehicleId') vehicleId: string,
    @Body() dto: UpsertVehicleScheduleDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.schedules.upsert(vehicleId, dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  /**
   * V1.5 (Sprint K) — Timeline des transitions automatiques (CUT/RESTORE)
   * sur les 90 derniers jours. Utilise par l'onglet Horaires de la fiche
   * vehicule (lecture seule).
   */
  @Get('history')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  async history(
    @Param('vehicleId') vehicleId: string,
    @Req() req: AuthenticatedRequest,
    @Query('limit') limitRaw?: string,
  ) {
    // Tenant check via vehicle.fleetId
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, fleetId: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicule introuvable');
    if (req.user.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }
    const limit = Math.max(1, Math.min(parseInt(limitRaw ?? '100', 10) || 100, 500));
    const since = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    const items = await this.prisma.scheduleHistory.findMany({
      where: { vehicleId, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
    return { items };
  }
}
