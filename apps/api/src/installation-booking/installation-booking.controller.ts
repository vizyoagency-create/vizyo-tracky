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
import { InstallationBookingStatus, UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  ConfirmBookingDto,
  CreateBookingLinkDto,
  RejectBookingDto,
  UpdateBookingLinkDto,
} from './dto/installation-booking.dto';
import { InstallationBookingService } from './installation-booking.service';

/**
 * Prise de RDV en ligne — administration (SUPER_ADMIN). Génération/gestion des liens
 * publics + traitement (validation/refus) des demandes de créneau. La partie PUBLIQUE
 * (page client) vit dans {@link PublicBookingController}, hors auth.
 *
 * NB base path `installation-bookings` (et PAS `installations`) : l'`InstallationsController`
 * existant a une route greedy `GET /installations/:id` qui capturerait `booking-links`/
 * `bookings` (→ cast UUID en erreur). On évite la collision avec un préfixe distinct.
 */
@Controller('installation-bookings')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class InstallationBookingController {
  constructor(private readonly service: InstallationBookingService) {}

  // ── Liens ──
  @Post('links')
  createLink(@Req() req: AuthenticatedRequest, @Body() dto: CreateBookingLinkDto) {
    return this.service.createLink(req.user.id, dto);
  }

  @Get('links')
  listLinks() {
    return this.service.listLinks();
  }

  @Patch('links/:id')
  updateLink(@Param('id') id: string, @Body() dto: UpdateBookingLinkDto) {
    return this.service.updateLink(id, dto);
  }

  @Delete('links/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteLink(@Param('id') id: string) {
    await this.service.deleteLink(id);
  }

  // ── Demandes ──
  @Get()
  listBookings(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const valid = ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED'];
    return this.service.listBookings({
      status: status && valid.includes(status) ? (status as InstallationBookingStatus) : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Post(':id/confirm')
  confirm(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: ConfirmBookingDto) {
    return this.service.confirmBooking(req.user.id, id, dto);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: RejectBookingDto) {
    return this.service.rejectBooking(id, dto);
  }
}
