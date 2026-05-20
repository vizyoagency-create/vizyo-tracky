import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AssignDriverDto } from '../drivers/dto/assign-driver.dto';
import { DriversService } from '../drivers/drivers.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import type { RequestedBy } from './vehicles.service';
import { VehiclesService } from './vehicles.service';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class VehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly drivers: DriversService,
  ) {}

  private async buildRequestedBy(req: AuthenticatedRequest): Promise<RequestedBy> {
    const accessibleVehicleIds = await this.vehicleAccess.getAccessibleVehicleIds(req.user);
    return { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds };
  }

  @Get('stats')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async stats(@Req() req: AuthenticatedRequest) {
    return this.vehicles.stats(await this.buildRequestedBy(req));
  }

  @Get('snapshot')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async snapshot(@Req() req: AuthenticatedRequest) {
    const items = await this.vehicles.snapshot(await this.buildRequestedBy(req));
    return { items };
  }

  @Post()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_create')
  create(@Body() dto: CreateVehicleDto, @Req() req: AuthenticatedRequest) {
    return this.vehicles.create(dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async findAll(
    @Req() req: AuthenticatedRequest,
    @Query('search') search?: string,
    @Query('hasTracker') hasTracker?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const requestedBy = await this.buildRequestedBy(req);
    return this.vehicles.findAll(requestedBy, { search, hasTracker, limit: limit ? parseInt(limit, 10) : undefined, cursor });
  }

  @Get(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.vehicles.findOne(id, await this.buildRequestedBy(req));
  }

  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_edit')
  update(@Param('id') id: string, @Body() dto: UpdateVehicleDto, @Req() req: AuthenticatedRequest) {
    return this.vehicles.update(id, dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_delete')
  remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.vehicles.remove(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  /**
   * Phase 2 — Definit/retire le conducteur "courant" du vehicule.
   * Snape sur Trip.driverId au prochain finalize (driverSource='AUTO').
   */
  @Patch(':id/driver')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('drivers_manage')
  assignDriver(
    @Param('id') id: string,
    @Body() dto: AssignDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.drivers.assignToVehicle(id, dto.driverId, {
      userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId,
    });
  }
}
