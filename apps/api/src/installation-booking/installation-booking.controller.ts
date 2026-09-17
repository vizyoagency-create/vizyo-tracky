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
import type { DeleteLinkMode } from '@vizyo/tracky-shared';
import {
  CancelBookingDto,
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

  /** Ce que la suppression emporterait — le dialogue de l'écran le lit avant de demander. */
  @Get('links/:id/consequences-suppression')
  consequencesSuppression(@Param('id') id: string) {
    return this.service.consequencesSuppression(id);
  }

  /**
   * Suppression (Q8) : `?demandes=conserver|effacer` dit quoi faire des demandes ; sans réponse
   * alors qu'il y en a, le service répond 409 avec le décompte.
   */
  @Delete('links/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteLink(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Query('demandes') demandes?: string) {
    const mode: DeleteLinkMode | undefined = demandes === 'conserver' || demandes === 'effacer' ? demandes : undefined;
    await this.service.deleteLink(id, mode, req.user.id);
  }

  /** Les visites de la page publique d'un lien : qui l'a ouvert, quand, depuis quoi, et la suite. */
  @Get('links/:id/visites')
  listerVisites(@Param('id') id: string) {
    return this.service.listerVisites(id);
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

  /** Annuler une demande — en attente ou confirmée ; les poses non faites sont retirées. */
  @Post(':id/cancel')
  cancel(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: CancelBookingDto) {
    return this.service.cancelBooking(req.user.id, id, dto);
  }
}
