import { BadRequestException, Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { ReviewGpsDeadZoneDto } from './dto/review-gps-dead-zone.dto';
import type { RequestedBy } from './gps-dead-zones.service';
import { GpsDeadZonesService } from './gps-dead-zones.service';

/**
 * Zones mortes GPS (suivi FS-253) — endroits où un véhicule perd récurremment son lock GPS
 * (parking souterrain/couvert, tunnel, brouilleur). Lecture scopée par accès véhicule ; la revue
 * (confirmer « normal » / marquer suspect / qualifier) demande la permission d'édition véhicule.
 */
@Controller('gps-dead-zones')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class GpsDeadZonesController {
  constructor(
    private readonly deadZones: GpsDeadZonesService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  private async buildRequestedBy(req: AuthenticatedRequest): Promise<RequestedBy> {
    const accessibleVehicleIds = await this.vehicleAccess.getAccessibleVehicleIds(req.user);
    return { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds };
  }

  /**
   * Zones mortes GPS de la FLOTTE pour la carte (parkings souterrains confirmés + zones
   * récurrentes/suspectes). Route STATIQUE → déclarée avant tout segment dynamique.
   * `fleetId` = sélecteur société (super-admin uniquement, ignoré sinon).
   */
  @Get('map')
  @Roles(
    UserRole.FLEET_ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.FLEET_MANAGER,
    UserRole.VIEWER,
    UserRole.NIGHT_WATCHMAN,
  )
  @RequirePermissions('vehicles_view')
  async listForMap(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.deadZones.listForMap(await this.buildRequestedBy(req), fleetId || undefined);
  }

  /** Zones mortes GPS d'un véhicule. `vehicleId` requis (le scoping d'accès est fait côté service). */
  @Get()
  @Roles(
    UserRole.FLEET_ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.FLEET_MANAGER,
    UserRole.VIEWER,
    UserRole.NIGHT_WATCHMAN,
  )
  @RequirePermissions('vehicles_view')
  async list(@Query('vehicleId') vehicleId: string, @Req() req: AuthenticatedRequest) {
    if (!vehicleId) throw new BadRequestException('vehicleId requis');
    return this.deadZones.listForVehicle(vehicleId, await this.buildRequestedBy(req));
  }

  /** Revue opérateur : confirmer « normal » (parking) / marquer suspect / qualifier la zone. */
  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_edit')
  async review(
    @Param('id') id: string,
    @Body() dto: ReviewGpsDeadZoneDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.deadZones.review(id, await this.buildRequestedBy(req), dto);
  }
}
