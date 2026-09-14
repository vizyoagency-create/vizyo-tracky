import {
  BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Ip, Param, Post, Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AbonnementCreneauDto,
  CreatePublicBookingDto,
  EnregistrerEvenementVisiteDto,
} from './dto/installation-booking.dto';
import { InstallationBookingService } from './installation-booking.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Prise de RDV en ligne — page PUBLIQUE (client, HORS AUTH). Le token (256 bits) est
 * dans l'URL — lien partageable façon Calendly, faible enjeu, stocké tel quel pour être
 * recopiable côté admin. Throttle strict (endpoint ouvert). Aucune donnée sensible : on
 * ne renvoie que le nom de la société + les créneaux libres.
 */
@Controller('public/booking')
export class PublicBookingController {
  constructor(private readonly service: InstallationBookingService) {}

  /**
   * Infos du lien + disponibilités — et l'ouverture d'une VISITE.
   *
   * Ce qu'on lit de la requête pour la décrire : l'IP (tronquée avant stockage), l'user-agent
   * (réduit à une famille d'appareil, jamais conservé) et la provenance (réduite à son hôte).
   *
   * ⚠️ LA PROVENANCE VIENT DE `?ref=` (le `document.referrer` de la page), PAS de l'en-tête
   * `Referer` : cet appel part de notre propre page, son `Referer` est donc toujours
   * nous-mêmes. L'en-tête ne sert que de repli pour un appelant qui n'est pas la page.
   * `?visite=` : la page qui recharge ses disponibilités après un créneau perdu passe sa
   * visite pour qu'on la RÉUTILISE — sinon chaque rechargement compterait pour un client.
   */
  @Get(':token')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  getLink(
    @Param('token') token: string,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('referer') referer?: string,
    @Query('visite') visite?: string,
    @Query('ref') ref?: string,
  ) {
    return this.service.getPublicLink(token, {
      ip,
      userAgent,
      referrer: typeof ref === 'string' ? ref.slice(0, 500) : referer,
      visiteId: visite && UUID.test(visite) ? visite : null,
    });
  }

  /** Dépose une demande de créneau. */
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 8 } })
  book(@Param('token') token: string, @Body() dto: CreatePublicBookingDto) {
    return this.service.createPublicBooking(token, dto);
  }

  /**
   * Un geste de la page (jour regardé, créneau choisi, vidéo ouverte, appel…), ajouté à la
   * chronologie de la visite. Répond toujours `{ ok: true }` sur un token valide : la page
   * n'a rien à faire d'un échec de suivi, et un 4xx ici serait un oracle sur les visites.
   *
   * Débit plus large que la réservation (un client curieux clique une dizaine de fois), mais
   * borné : au-delà de 60 gestes par minute, ce n'est plus un client.
   */
  @Post(':token/visites/:visiteId/evenements')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  evenement(
    @Param('token') token: string,
    @Param('visiteId') visiteId: string,
    @Body() dto: EnregistrerEvenementVisiteDto,
  ) {
    if (!UUID.test(visiteId)) throw new BadRequestException('Visite invalide.');
    return this.service.enregistrerEvenement(token, visiteId, dto);
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
  watch(@Param('token') token: string, @Body() body: AbonnementCreneauDto) {
    const email = (body?.email ?? '').trim();
    // Validation volontairement simple : la seule garantie qui compte est qu'un
    // e-mail PARTE, et elle se vérifie à l'envoi. Une expression compliquée ici
    // refuserait des adresses valides sans rien prouver de plus.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
      throw new BadRequestException('Adresse e-mail invalide.');
    }
    return this.service.watchSlots(token, email, body.visiteId ?? null);
  }
}
