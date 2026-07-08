import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TripAnalysisController } from './trip-analysis.controller';
import { TripAnalysisService } from './trip-analysis.service';
import { TripAnalysisLlmService } from './trip-analysis-llm.service';
import { DrivingScoreService } from './driving-score.service';
import { SpeedLimitService } from './speed-limit.service';
import { FuelStationService } from './fuel-station.service';
import { FuelReportService } from './fuel-report.service';

/**
 * Traçabilité fine des trajets (Palier 2 déterministe + Palier 3 récit LLM). AuthModule fournit les
 * guards ; PrismaService, VehicleAccessService, AiRouter, AiUsageService, ErrorLogger sont globaux ;
 * le préprocesseur est une fonction pure (pas un provider).
 */
@Module({
  imports: [AuthModule],
  controllers: [TripAnalysisController],
  providers: [TripAnalysisService, TripAnalysisLlmService, DrivingScoreService, SpeedLimitService, FuelStationService, FuelReportService],
  exports: [TripAnalysisService],
})
export class TripAnalysisModule {}
