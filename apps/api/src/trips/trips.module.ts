import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DriversModule } from '../drivers/drivers.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MapMatchingService } from './map-matching.service';
import { TripMapMatchingService } from './trip-map-matching.service';
import { TripSegmenterService } from './trip-segmenter.service';
import { TripsController } from './trips.controller';
import { TripsRetentionService } from './trips-retention.service';
import { TripsService } from './trips.service';

@Module({
  imports: [forwardRef(() => RealtimeModule), AuthModule, DriversModule],
  controllers: [TripsController],
  providers: [TripsService, TripSegmenterService, MapMatchingService, TripMapMatchingService, TripsRetentionService],
  // `TripMapMatchingService` est exporté pour le RATTRAPAGE de l'automatisation (2026-09-08) :
  // il recale par lots bornés les tracés de l'historique, en réutilisant le verrou et le
  // stockage du recalage à la demande — deux chemins, une seule façon de ranger un tracé.
  exports: [TripsService, TripMapMatchingService],
})
export class TripsModule {}
