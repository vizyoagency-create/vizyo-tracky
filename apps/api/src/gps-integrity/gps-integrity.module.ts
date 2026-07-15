import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { GpsDeadZonesModule } from '../gps-dead-zones/gps-dead-zones.module';
import { GpsIntegrityService } from './gps-integrity.service';

/**
 * Incident FS-253 — module du détecteur « GPS perdu » (boîtier vivant sans position GPS).
 * PrismaService et ErrorLogger sont globaux ; on importe AlertsModule (AlertsService) et
 * GpsDeadZonesModule (enregistrement/clustering des pertes récurrentes = zones mortes GPS).
 */
@Module({
  imports: [AlertsModule, GpsDeadZonesModule],
  providers: [GpsIntegrityService],
})
export class GpsIntegrityModule {}
