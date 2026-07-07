import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TripAnalysisController } from './trip-analysis.controller';
import { TripAnalysisService } from './trip-analysis.service';
import { SpeedLimitService } from './speed-limit.service';

/**
 * Traçabilité fine des trajets (Palier 2). AuthModule fournit les guards ; PrismaService et
 * VehicleAccessService sont globaux ; le préprocesseur est une fonction pure (pas un provider).
 */
@Module({
  imports: [AuthModule],
  controllers: [TripAnalysisController],
  providers: [TripAnalysisService, SpeedLimitService],
  exports: [TripAnalysisService],
})
export class TripAnalysisModule {}
