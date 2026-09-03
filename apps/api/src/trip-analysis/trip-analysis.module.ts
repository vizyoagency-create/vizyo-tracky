import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AlertsModule } from '../alerts/alerts.module';
import { TripsModule } from '../trips/trips.module';
import { TripAnalysisController } from './trip-analysis.controller';
import { TripAnalysisService } from './trip-analysis.service';
import { TripAnalysisLlmService } from './trip-analysis-llm.service';
import { TripAutomationService } from './trip-automation.service';
import { DrivingScoreService } from './driving-score.service';
import { SpeedLimitService } from './speed-limit.service';
import { FuelStationService } from './fuel-station.service';
import { FuelReportService } from './fuel-report.service';
import { FuelCalibrationService } from './fuel-calibration.service';

/**
 * Traçabilité fine des trajets (Palier 2 déterministe + Palier 3 récit LLM) + automatisation (cron).
 * AuthModule fournit les guards ; TripsModule fournit le recompute des trajets ; PrismaService,
 * VehicleAccessService, AiRouter, AiUsageService, AiAvailabilityService, SystemActivityService,
 * ErrorLogger sont globaux ; le préprocesseur est une fonction pure (pas un provider).
 */
@Module({
  // AlertsModule (lot V5) : l'analyse alerte sur les excès qu'elle mesure. Aucun cycle —
  // ni AlertsModule ni ses imports ne remontent vers ce module.
  imports: [AuthModule, TripsModule, AlertsModule],
  controllers: [TripAnalysisController],
  providers: [TripAnalysisService, TripAnalysisLlmService, TripAutomationService, DrivingScoreService, SpeedLimitService, FuelStationService, FuelReportService, FuelCalibrationService],
  // `TripAutomationService` est exporté pour l'écran des tâches de fond : il y lit le reste à
  // faire des récits par `resteRecitTotal()`, seule définition de ce chiffre dans l'application.
  exports: [TripAnalysisService, TripAutomationService],
})
export class TripAnalysisModule {}
