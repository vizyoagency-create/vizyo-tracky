import { Module } from '@nestjs/common';
import { AgendaModule } from '../agenda/agenda.module';
import { AuthModule } from '../auth/auth.module';
import { SmsModule } from '../sms/sms.module';
import { PublicReservationBookingController } from './public-reservation-booking.controller';
import { ReservationBookingNotifier } from './reservation-booking-notifier.service';
import { ReservationBookingController } from './reservation-booking.controller';
import { ReservationBookingService } from './reservation-booking.service';

/**
 * Refonte agenda/IA (2026-07, P4) — Lien public de demande de réservation.
 * AgendaModule fournit ReservationsService (dispo + création REQUESTED) ; AuthModule les guards ;
 * SmsModule fournit SmsGatewayService (notif SMS). EmailService, ErrorLogger, SystemActivityService,
 * PrismaService sont globaux.
 */
@Module({
  imports: [AuthModule, AgendaModule, SmsModule],
  controllers: [ReservationBookingController, PublicReservationBookingController],
  providers: [ReservationBookingService, ReservationBookingNotifier],
})
export class ReservationBookingModule {}
