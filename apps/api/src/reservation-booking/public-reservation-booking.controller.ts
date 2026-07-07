import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  ParsePublicNeedDto,
  SubmitPublicReservationDto,
} from '@vizyo/tracky-shared';
import { ReservationBookingService } from './reservation-booking.service';

/**
 * Refonte agenda/IA (2026-07, P4) — Endpoints PUBLICS (HORS AUTH) du lien de réservation.
 * Public = simple absence de `@UseGuards(JwtAuthGuard)` (cf. installation-booking). Débit borné
 * par méthode. La société est déterminée par le token (jamais par le client).
 */
@Controller('public/reserve')
export class PublicReservationBookingController {
  constructor(private readonly svc: ReservationBookingService) {}

  /** Infos publiques du lien (société, libellé, bornes de créneau) + suivi d'ouverture. */
  @Get(':token')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  get(@Param('token') token: string) {
    return this.svc.getPublic(token);
  }

  /** Analyse IA rapide d'un besoin DICTÉ (voix → texte) → champs (places/destination/créneau). */
  @Post(':token/parse')
  @Throttle({ default: { ttl: 60_000, limit: 15 } })
  parse(@Param('token') token: string, @Body() dto: ParsePublicNeedDto) {
    return this.svc.parsePublic(token, dto?.text ?? '');
  }

  // #4 — La route publique /suggest a été RETIRÉE : un lien public ne doit PAS exposer les véhicules
  // (données sensibles). Le demandeur décrit son besoin et soumet ; le serveur choisit le véhicule
  // à la soumission (invisible au demandeur), et un gestionnaire valide.

  /** Soumission : crée des demandes REQUESTED (file de validation) — véhicule choisi côté serveur. */
  @Post(':token/submit')
  @Throttle({ default: { ttl: 60_000, limit: 8 } })
  submit(@Param('token') token: string, @Body() dto: SubmitPublicReservationDto) {
    return this.svc.submitPublic(token, dto ?? ({} as SubmitPublicReservationDto));
  }
}
