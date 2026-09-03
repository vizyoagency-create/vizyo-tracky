import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { AlertsService } from './alerts.service';
import { ListAlertsDto } from './dto/list-alerts.dto';
import { SetSpeedAlertSettingsDto, SetVehicleSpeedAlertOverrideDto } from './dto/set-speed-alert-settings.dto';
import { SpeedAlertSettingsService } from './speed-alert-settings.service';

@Controller('alerts')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly speedSettings: SpeedAlertSettingsService,
  ) {}

  private async rb(req: AuthenticatedRequest) {
    const accessibleVehicleIds = await this.vehicleAccess.getAccessibleVehicleIds(req.user);
    return { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds };
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('alerts_view')
  async list(@Req() req: AuthenticatedRequest, @Query() query: ListAlertsDto) {
    return this.alerts.list(await this.rb(req), query);
  }

  @Get('unacknowledged/count')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('alerts_view')
  async count(@Req() req: AuthenticatedRequest) {
    return this.alerts.countUnacknowledged(await this.rb(req));
  }

  // ── Lot V5 — réglage des alertes de vitesse (société, surcharge véhicule) ──────────
  // Un super-admin passe `?fleetId=` (la société du sélecteur) ; les autres règlent la leur.

  @Get('speed-settings')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('alerts_view')
  speedSettingsGet(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.speedSettings.get(req.user, fleetId);
  }

  @Put('speed-settings')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('alerts_configure')
  speedSettingsSet(
    @Req() req: AuthenticatedRequest,
    @Body() body: SetSpeedAlertSettingsDto,
    @Query('fleetId') fleetId?: string,
  ) {
    return this.speedSettings.set(req.user, body, fleetId);
  }

  @Put('speed-settings/vehicles/:vehicleId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('alerts_configure')
  speedSettingsSetVehicle(
    @Req() req: AuthenticatedRequest,
    @Param('vehicleId') vehicleId: string,
    @Body() body: SetVehicleSpeedAlertOverrideDto,
    @Query('fleetId') fleetId?: string,
  ) {
    return this.speedSettings.setVehicle(req.user, vehicleId, body, fleetId);
  }

  @Post(':id/acknowledge')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('alerts_acknowledge')
  acknowledge(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.alerts.acknowledge(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Post('acknowledge-all')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('alerts_acknowledge')
  acknowledgeAll(@Req() req: AuthenticatedRequest) {
    return this.alerts.acknowledgeAll({
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }
}
