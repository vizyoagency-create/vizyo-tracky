import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
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

  /**
   * « Prévenez-moi si un créneau se libère » — la 3e sortie de la page.
   *
   * ⚠️ ENDPOINT PUBLIC QUI COLLECTE UNE DONNÉE PERSONNELLE. Trois garde-fous :
   *  - une seule donnée demandée, l'e-mail ; ni nom, ni téléphone, ni adresse ;
   *  - `@Throttle` plus serré que la réservation — un formulaire d'inscription
   *    ouvert est une cible d'abus, pas un formulaire comme un autre ;
   *  - la conservation est bornée côté service (`SLOT_WATCH_RETENTION_DAYS`) et
   *    purgée : la donnée part quand la finalité s'épuise.
   */
  @Post(':token/prevenir-moi')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 4 } })
  watch(@Param('token') token: string, @Body() body: { email?: string }) {
    const email = (body?.email ?? '').trim();
    // Validation volontairement simple : la seule garantie qui compte est qu'un
    // e-mail PARTE, et elle se vérifie à l'envoi. Une expression compliquée ici
    // refuserait des adresses valides sans rien prouver de plus.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
      throw new BadRequestException('Adresse e-mail invalide.');
    }
    return this.service.watchSlots(token, email);
  }
}
