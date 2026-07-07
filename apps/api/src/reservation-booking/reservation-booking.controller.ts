import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { CreateReservationBookingLinkDto } from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ReservationBookingService } from './reservation-booking.service';

/**
 * Refonte agenda/IA (2026-07, P4) — Gestion ADMIN des liens publics de réservation.
 * Super-admin (choisit la société via fleetId) + fleet-admin (scopé à la sienne dans le service).
 * Base path distinct (pas sous `reservations/`) pour éviter toute collision de route greedy.
 */
@Controller('reservation-booking-links')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReservationBookingController {
  constructor(private readonly svc: ReservationBookingService) {}

  /** Crée un lien public (société fixe). */
  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateReservationBookingLinkDto) {
    return this.svc.createLink(req.user, dto ?? {});
  }

  /** Liste les liens (scopée). */
  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  list(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.svc.listLinks(req.user, fleetId);
  }

  /** Active / désactive un lien. */
  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  setActive(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { active?: boolean },
  ) {
    return this.svc.setActive(req.user, id, !!body?.active);
  }
}
