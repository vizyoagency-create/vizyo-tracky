import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { InstallationBookingController } from './installation-booking.controller';
import { InstallationBookingService } from './installation-booking.service';
import { PublicBookingController } from './public-booking.controller';

/**
 * Prise de RDV en ligne (lien public de réservation de créneau d'installation).
 * Deux surfaces : admin (SUPER_ADMIN, sous JwtAuthGuard) et publique (hors auth).
 */
@Module({
  imports: [AuthModule, EmailModule],
  controllers: [InstallationBookingController, PublicBookingController],
  providers: [InstallationBookingService],
})
export class InstallationBookingModule {}
