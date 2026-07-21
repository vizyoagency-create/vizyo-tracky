import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrivacyModeController } from './privacy-mode.controller';
import { PrivacyModeService } from './privacy-mode.service';
import { PrivacyCoverageController } from './privacy-coverage.controller';
import { WorkScheduleController } from './work-schedule.controller';
import { WorkScheduleService } from './work-schedule.service';

/**
 * Mode vie privée conducteur + CADRE de temps de travail (par véhicule). ErrorLogger +
 * SystemActivityService sont @Global (aucun import requis). PrismaService global.
 */
@Module({
  imports: [AuthModule],
  controllers: [PrivacyModeController, WorkScheduleController, PrivacyCoverageController],
  providers: [PrivacyModeService, WorkScheduleService],
  exports: [PrivacyModeService, WorkScheduleService],
})
export class PrivacyModeModule {}
