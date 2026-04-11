import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GeofencesModule } from '../geofences/geofences.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TripsModule } from '../trips/trips.module';
import { PositionsController } from './positions.controller';
import { PositionsService } from './positions.service';

@Module({
  imports: [
    forwardRef(() => RealtimeModule),
    forwardRef(() => GeofencesModule),
    forwardRef(() => TripsModule),
    AuthModule,
  ],
  controllers: [PositionsController],
  providers: [PositionsService],
  exports: [PositionsService],
})
export class PositionsModule {}
