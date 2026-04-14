import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UpsertVehicleScheduleDto } from './dto/upsert-vehicle-schedule.dto';
import { VehicleSchedulesService } from './vehicle-schedules.service';

@Controller('vehicles/:vehicleId/schedule')
@UseGuards(JwtAuthGuard, RolesGuard)
export class VehicleSchedulesController {
  constructor(private readonly schedules: VehicleSchedulesService) {}

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
}
