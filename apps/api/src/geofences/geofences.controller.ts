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
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { UpdateGeofenceDto } from './dto/update-geofence.dto';
import { GeofencesService } from './geofences.service';

@Controller('geofences')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class GeofencesController {
  constructor(private readonly geofences: GeofencesService) {}

  @Post()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('geofences_manage')
  create(@Body() dto: CreateGeofenceDto, @Req() req: AuthenticatedRequest) {
    return this.geofences.create(dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('geofences_view')
  findAll(@Req() req: AuthenticatedRequest) {
    return this.geofences.findAll({
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Get(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('geofences_view')
  findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.geofences.findOne(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('geofences_manage')
  update(@Param('id') id: string, @Body() dto: UpdateGeofenceDto, @Req() req: AuthenticatedRequest) {
    return this.geofences.update(id, dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('geofences_manage')
  remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.geofences.remove(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  // ─── V1.5 (Sprint N) ────────────────────────────────────────

  @Post('import-geojson')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('geofences_manage')
  importGeoJson(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    return this.geofences.importGeoJson(body, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Get(':id/vehicles')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('geofences_view')
  getVehicleTargets(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.geofences.getVehicleTargets(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Post(':id/vehicles')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('geofences_manage')
  setVehicleTargets(
    @Param('id') id: string,
    @Body() body: { vehicleIds: string[] },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.geofences.setVehicleTargets(id, body.vehicleIds ?? [], {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }
}
