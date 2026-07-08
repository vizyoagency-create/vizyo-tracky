import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { GpsIntegrityService } from './gps-integrity.service';

/**
 * Incident FS-253 — module du détecteur « GPS perdu » (boîtier vivant sans position GPS).
 * PrismaService et ErrorLogger sont globaux ; on n'importe qu'AlertsModule pour AlertsService.
 */
@Module({
  imports: [AlertsModule],
  providers: [GpsIntegrityService],
})
export class GpsIntegrityModule {}
