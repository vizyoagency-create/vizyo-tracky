import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  PublicReservationSuggestRequestDto,
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

  /** Recherche : véhicules/combinaisons disponibles pour le besoin décrit. */
  @Post(':token/suggest')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  suggest(@Param('token') token: string, @Body() dto: PublicReservationSuggestRequestDto) {
    return this.svc.suggestPublic(token, dto ?? ({} as PublicReservationSuggestRequestDto));
  }

  /** Soumission : crée des demandes REQUESTED (file de validation). */
  @Post(':token/submit')
  @Throttle({ default: { ttl: 60_000, limit: 8 } })
  submit(@Param('token') token: string, @Body() dto: SubmitPublicReservationDto) {
    return this.svc.submitPublic(token, dto ?? ({} as SubmitPublicReservationDto));
  }
}
