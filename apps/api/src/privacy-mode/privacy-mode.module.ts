import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrivacyModeController } from './privacy-mode.controller';
import { PrivacyModeService } from './privacy-mode.service';

/**
 * Mode vie privée conducteur (par véhicule). ErrorLogger + SystemActivityService
 * sont @Global (aucun import requis). PrismaService global.
 */
@Module({
  imports: [AuthModule],
  controllers: [PrivacyModeController],
  providers: [PrivacyModeService],
  exports: [PrivacyModeService],
})
export class PrivacyModeModule {}
