import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GeofencesModule } from '../geofences/geofences.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TrackerFixModeModule } from '../tracker-fix-mode/tracker-fix-mode.module';
import { TripsModule } from '../trips/trips.module';
import { AdminSamplingController } from './admin-sampling.controller';
import { IgnitionInferredCleanupService } from './ignition-inferred-cleanup.service';
import { PositionHistoryService } from './position-history.service';
import { PositionSamplingService } from './position-sampling.service';
import { PositionsController } from './positions.controller';
import { PositionsService } from './positions.service';

@Module({
  imports: [
    forwardRef(() => RealtimeModule),
    forwardRef(() => GeofencesModule),
    forwardRef(() => TripsModule),
    TrackerFixModeModule,
    AuthModule,
  ],
  controllers: [PositionsController, AdminSamplingController],
  providers: [
    PositionsService,
    PositionSamplingService,
    PositionHistoryService,
    IgnitionInferredCleanupService,
  ],
  exports: [PositionsService, PositionSamplingService, PositionHistoryService],
})
export class PositionsModule {}
