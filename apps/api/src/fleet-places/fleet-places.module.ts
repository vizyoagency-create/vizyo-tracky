import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FleetPlacesController } from './fleet-places.controller';
import { FleetPlacesService } from './fleet-places.service';

/**
 * Lieux clés — stations-service validées par la flotte + parkings / stationnements récurrents.
 * PrismaService, VehicleAccessService et ErrorLogger sont globaux ; on n'importe qu'AuthModule
 * pour les guards du controller.
 */
@Module({
  imports: [AuthModule],
  controllers: [FleetPlacesController],
  providers: [FleetPlacesService],
  exports: [FleetPlacesService],
})
export class FleetPlacesModule {}
