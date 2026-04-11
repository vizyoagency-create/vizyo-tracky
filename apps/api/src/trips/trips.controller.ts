import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ListTripsDto } from './dto/list-trips.dto';
import { RecomputeTripsDto } from './dto/recompute-trips.dto';
import { TripsService } from './trips.service';

@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  list(@Req() req: AuthenticatedRequest, @Query() query: ListTripsDto) {
    return this.trips.list(
      { userId: req.user.sub, role: req.user.role as UserRole, fleetId: req.user.fleetId },
      query,
    );
  }

  @Get('daily-summary')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  dailySummary(
    @Req() req: AuthenticatedRequest,
    @Query('vehicleId') vehicleId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.trips.dailySummary(
      { userId: req.user.sub, role: req.user.role as UserRole, fleetId: req.user.fleetId },
      { vehicleId, from, to },
    );
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.trips.findOne(id, {
      userId: req.user.sub,
      role: req.user.role as UserRole,
      fleetId: req.user.fleetId,
    });
  }

  @Post('recompute')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  recompute(@Body() dto: RecomputeTripsDto, @Req() req: AuthenticatedRequest) {
    return this.trips.recompute(
      { userId: req.user.sub, role: req.user.role as UserRole, fleetId: req.user.fleetId },
      dto,
    );
  }
}
