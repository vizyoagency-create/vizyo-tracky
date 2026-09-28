import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { SetChildSeatStockDto } from '@vizyo/tracky-shared';
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
 * Sièges auto (2026-09-28) — le STOCK de la société et ce qu'il en reste sur un créneau.
 *
 * Le réglage suit la garde de « Paramètres de l'agenda » (SUPER_ADMIN + FLEET_ADMIN : c'est un
 * réglage de société). La lecture suit celle des réservations : quiconque peut en déposer une
 * doit voir combien de sièges il peut demander.
 */
@Controller('agenda/child-seats')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class ChildSeatsController {
  constructor(private readonly svc: ChildSeatsService) {}

  /** GET /api/agenda/child-seats?fleetId= — le stock (bébé / enfant). */
  @Get()
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  stock(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.svc.getStock(req.user, fleetId);
  }

  /** PUT /api/agenda/child-seats — règle le stock. */
  @Put()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  setStock(@Req() req: AuthenticatedRequest, @Body() dto: SetChildSeatStockDto) {
    return this.svc.setStock(req.user, dto ?? ({} as SetChildSeatStockDto));
  }

  /**
   * GET /api/agenda/child-seats/availability?startAt&endAt&fleetId&excludeId — stock, engagés,
   * disponibles sur le créneau. `excludeId` : la réservation en cours d'édition ne se compte pas.
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
  ) {
    return this.svc.availabilityFor(req.user, { fleetId, startAt, endAt, excludeId: excludeId || undefined });
  }
}
