import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FleetPlacesController } from './fleet-places.controller';
import { FleetPlacesService } from './fleet-places.service';
import { PlaceEnrichmentService } from './place-enrichment.service';

/**
 * Lieux clés — stations-service validées par la flotte + parkings / stationnements récurrents.
 * PrismaService, VehicleAccessService et ErrorLogger sont globaux ; on n'importe qu'AuthModule
 * pour les guards du controller.
 */
@Module({
  imports: [AuthModule],
  controllers: [FleetPlacesController],
  providers: [FleetPlacesService, PlaceEnrichmentService],
  exports: [FleetPlacesService, PlaceEnrichmentService],
})
export class FleetPlacesModule {}
