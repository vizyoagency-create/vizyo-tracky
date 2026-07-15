import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GpsDeadZonesController } from './gps-dead-zones.controller';
import { GpsDeadZonesService } from './gps-dead-zones.service';

/**
 * Zones mortes GPS (suivi FS-253). PrismaService, ReverseGeocodeService et VehicleAccessService
 * sont globaux ; on n'importe que AuthModule pour les guards du controller. Le service est exporté
 * pour être injecté par le détecteur gps-integrity (enregistrement des pertes au fil de l'eau).
 */
@Module({
  imports: [AuthModule],
  controllers: [GpsDeadZonesController],
  providers: [GpsDeadZonesService],
  exports: [GpsDeadZonesService],
})
export class GpsDeadZonesModule {}
