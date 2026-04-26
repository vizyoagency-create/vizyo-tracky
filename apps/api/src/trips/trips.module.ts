import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MapMatchingService } from './map-matching.service';
import { TripSegmenterService } from './trip-segmenter.service';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

@Module({
  imports: [forwardRef(() => RealtimeModule), AuthModule],
  controllers: [TripsController],
  providers: [TripsService, TripSegmenterService, MapMatchingService],
  exports: [TripsService],
})
export class TripsModule {}
