import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CreatePublicBookingDto } from './dto/installation-booking.dto';
import { InstallationBookingService } from './installation-booking.service';

/**
 * Prise de RDV en ligne — page PUBLIQUE (client, HORS AUTH). Le token brut est dans
 * l'URL ; seul son SHA-256 est stocké. Throttle strict (endpoint ouvert). Aucune donnée
 * sensible : on ne renvoie que le nom de la société + les créneaux libres.
 */
@Controller('public/booking')
export class PublicBookingController {
  constructor(private readonly service: InstallationBookingService) {}

  /** Infos du lien + disponibilités. */
  @Get(':token')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  getLink(@Param('token') token: string) {
    return this.service.getPublicLink(token);
  }

  /** Dépose une demande de créneau. */
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 8 } })
  book(@Param('token') token: string, @Body() dto: CreatePublicBookingDto) {
    return this.service.createPublicBooking(token, dto);
  }
}
