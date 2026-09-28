import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { SetChildSeatStockDto, SetVehicleChildSeatsDto } from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ChildSeatsService } from './child-seats.service';

const ALL_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.FLEET_ADMIN,
  UserRole.FLEET_MANAGER,
  UserRole.VIEWER,
  UserRole.NIGHT_WATCHMAN,
];

/**
 * Sièges auto (2026-09-28) — ce que la société possède, ce qui est à bord de chaque véhicule, la
 * politique (le stock complète-t-il un véhicule non équipé ?), et ce qu'un créneau permet.
 *
 * Les réglages suivent la garde de « Paramètres de l'agenda » (SUPER_ADMIN + FLEET_ADMIN : c'est un
 * réglage de société). La lecture suit celle des réservations : quiconque peut en déposer une doit
 * voir combien de sièges il peut demander.
 */
@Controller('agenda/child-seats')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class ChildSeatsController {
  constructor(private readonly svc: ChildSeatsService) {}

  /** GET /api/agenda/child-seats?fleetId= — possédés, installés (par véhicule), stock, politique. */
  @Get()
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  stock(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.svc.getStock(req.user, fleetId);
  }

  /** PUT /api/agenda/child-seats — règle le total possédé et la politique. */
  @Put()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  setStock(@Req() req: AuthenticatedRequest, @Body() dto: SetChildSeatStockDto) {
    return this.svc.setStock(req.user, dto ?? ({} as SetChildSeatStockDto));
  }

  /** PUT /api/agenda/child-seats/vehicles/:vehicleId — règle les sièges à bord d'un véhicule. */
  @Put('vehicles/:vehicleId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  setVehicleSeats(
    @Req() req: AuthenticatedRequest,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @Body() dto: SetVehicleChildSeatsDto,
  ) {
    return this.svc.setVehicleSeats(req.user, vehicleId, dto ?? ({} as SetVehicleChildSeatsDto));
  }

  /**
   * GET /api/agenda/child-seats/availability?startAt&endAt&fleetId&excludeId&vehicleId — politique,
   * stock, engagés, disponibles sur le créneau, et les sièges à bord du véhicule visé.
   * `excludeId` : la réservation en cours d'édition ne se compte pas.
   */
  @Get('availability')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  availability(
    @Req() req: AuthenticatedRequest,
    @Query('startAt') startAt: string,
    @Query('endAt') endAt: string,
    @Query('fleetId') fleetId?: string,
    @Query('excludeId') excludeId?: string,
    @Query('vehicleId') vehicleId?: string,
  ) {
    return this.svc.availabilityFor(req.user, {
      fleetId,
      startAt,
      endAt,
      excludeId: excludeId || undefined,
      vehicleId: vehicleId || undefined,
    });
  }
}
