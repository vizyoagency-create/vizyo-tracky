import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateFleetPlaceDto, UpdateFleetPlaceDto } from './dto/fleet-place.dto';
import { FleetPlacesService } from './fleet-places.service';

/**
 * Lieux clés (2026-07) — stations-service validées par la flotte + parkings / stationnements
 * récurrents. Lecture : `places_view`. Écriture : `places_manage` (accordée aux managers par
 * défaut). Le scoping société/véhicules est appliqué côté service (anti-IDOR).
 */
@Controller('fleet-places')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class FleetPlacesController {
  constructor(private readonly places: FleetPlacesService) {}

  /**
   * Passages en station-service avec un VRAI arrêt (≥ `minStopMin`, 4 min par défaut).
   * Route STATIQUE → déclarée avant tout segment dynamique.
   */
  @Get('station-passages')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('places_view')
  stationPassages(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
    @Query('minStopMin') minStopMin?: string,
  ) {
    const min = minStopMin ? Number(minStopMin) : undefined;
    return this.places.stationPassages(req.user, {
      fromIso: from,
      toIso: to,
      fleetId,
      minStopMin: Number.isFinite(min) ? min : undefined,
    });
  }

  /** Lieux clés de la flotte (stations validées + parkings + dépôts). */
  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('places_view')
  list(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.places.list(req.user, fleetId);
  }

  /** Crée un lieu : parking/stationnement à la main, ou validation d'une station détectée. */
  @Post()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('places_manage')
  create(@Body() dto: CreateFleetPlaceDto, @Req() req: AuthenticatedRequest) {
    return this.places.create(req.user, dto);
  }

  /** Modifie un lieu (nom, nature, position, rayon, note). */
  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('places_manage')
  update(@Param('id') id: string, @Body() dto: UpdateFleetPlaceDto, @Req() req: AuthenticatedRequest) {
    return this.places.update(req.user, id, dto);
  }

  /** Retire un lieu (dévalide une station, ou efface un parking). */
  @Delete(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('places_manage')
  remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.places.remove(req.user, id);
  }
}
