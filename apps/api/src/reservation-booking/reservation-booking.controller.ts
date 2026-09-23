import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { CreateReservationBookingLinkDto } from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ReservationBookingService } from './reservation-booking.service';

/**
 * Refonte agenda/IA (2026-07, P4) — Gestion ADMIN des liens publics de réservation.
 * Super-admin (choisit la société via fleetId) + fleet-admin (scopé à la sienne dans le service).
 * Base path distinct (pas sous `reservations/`) pour éviter toute collision de route greedy.
 */
@Controller('reservation-booking-links')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class ReservationBookingController {
  constructor(private readonly svc: ReservationBookingService) {}

  /** Crée un lien public (société fixe). */
  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateReservationBookingLinkDto) {
    return this.svc.createLink(req.user, dto ?? {});
  }

  /**
   * Liste les liens (scopée) — LECTURE ouverte à qui peut VALIDER les demandes (2026-09-23).
   *
   * Créer ou désactiver un lien reste un geste de gouvernance (admin). Le LIRE ne l'est pas : le
   * lien est fait pour être distribué, et c'est le standard — un FLEET_MANAGER — qui imprime le
   * QR et le remet aux conducteurs. Lui refuser la lecture obligeait un admin à faire le geste à
   * sa place, ou à copier l'URL à la main hors de l'application.
   *
   * La barrière reste réelle : `reservations_manage`, la même permission que la file de
   * validation vers laquelle ce lien envoie ses demandes.
   */
  @Get()
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.FLEET_ADMIN,
    UserRole.FLEET_MANAGER,
    UserRole.VIEWER,
    UserRole.NIGHT_WATCHMAN,
  )
  @RequirePermissions('reservations_manage')
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
