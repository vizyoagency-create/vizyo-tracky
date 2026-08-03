import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AssignDriverDto } from '../drivers/dto/assign-driver.dto';
import { DriversService } from '../drivers/drivers.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { ListTripsDto } from './dto/list-trips.dto';
import { RecomputeTripsDto } from './dto/recompute-trips.dto';
import { UpdateTripNoteDto } from './dto/update-trip-note.dto';
import { TripsService } from './trips.service';

@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripsController {
  constructor(
    private readonly trips: TripsService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly drivers: DriversService,
  ) {}

  private async rb(req: AuthenticatedRequest) {
    const accessibleVehicleIds = await this.vehicleAccess.getAccessibleVehicleIds(req.user);
    return { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds };
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async list(@Req() req: AuthenticatedRequest, @Query() query: ListTripsDto) {
    return this.trips.list(await this.rb(req), query);
  }

  @Get('daily-summary')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async dailySummary(
    @Req() req: AuthenticatedRequest,
    @Query('vehicleId') vehicleId?: string,
    @Query('vehicleIds') vehicleIds?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
  ) {
    return this.trips.dailySummary(await this.rb(req), { vehicleId, vehicleIds, from, to, fleetId });
  }

  /**
   * Données des graphiques « Vitesses max » et « Fréquentation », sur la période ENTIÈRE.
   *
   * ⚠️ DOIT rester déclaré AVANT `@Get(':id')` : Nest résout les routes dans l'ordre de
   * déclaration, et `:id` capturerait « period-charts » comme un identifiant de trajet.
   * C'est la même raison qui place `daily-summary` juste au-dessus.
   */
  @Get('period-charts')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async periodCharts(
    @Req() req: AuthenticatedRequest,
    @Query('vehicleId') vehicleId?: string,
    @Query('vehicleIds') vehicleIds?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
  ) {
    return this.trips.periodCharts(await this.rb(req), { vehicleId, vehicleIds, from, to, fleetId });
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    // rb() inclut accessibleVehicleIds pour appliquer l'acces granulaire (groupes).
    return this.trips.findOne(id, await this.rb(req));
  }

  @Post('recompute')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  recompute(@Body() dto: RecomputeTripsDto, @Req() req: AuthenticatedRequest) {
    return this.trips.recompute(
      { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId },
      dto,
    );
  }

  @Patch(':id/notes')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  async updateNote(
    @Param('id') id: string,
    @Body() dto: UpdateTripNoteDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.trips.updateNote(id, await this.rb(req), dto.notes);
  }

  /**
   * Phase 2 — Assigne (ou retire) un conducteur sur un trajet a posteriori.
   * driverId=null retire l'assignation. Set driverSource='MANUAL'.
   */
  @Patch(':id/driver')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  async updateDriver(
    @Param('id') id: string,
    @Body() dto: AssignDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.drivers.assignToTrip(id, dto.driverId, {
      userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId,
    });
  }
}
