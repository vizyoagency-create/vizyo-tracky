import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FleetPlacesController } from './fleet-places.controller';
import { FleetPlacesService } from './fleet-places.service';
import { PlaceAnalysisService } from './place-analysis.service';
import { PlaceAutomationService } from './place-automation.service';
import { PlaceEnrichmentService } from './place-enrichment.service';

/**
 * Lieux clés — stations-service validées par la flotte + parkings / stationnements récurrents.
 * PrismaService, VehicleAccessService et ErrorLogger sont globaux ; AiRouter / AiAvailabilityService
 * viennent d'`AiCoreModule` (@Global) et AiUsageService d'`AiUsageModule` (@Global) — donc rien à
 * importer pour l'analyse IA. On n'importe qu'AuthModule pour les guards du controller.
 */
@Module({
  imports: [AuthModule],
  controllers: [FleetPlacesController],
  providers: [FleetPlacesService, PlaceEnrichmentService, PlaceAnalysisService, PlaceAutomationService],
  exports: [FleetPlacesService, PlaceEnrichmentService, PlaceAnalysisService, PlaceAutomationService],
})
export class FleetPlacesModule {}
