import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GeofencesModule } from '../geofences/geofences.module';
import { GpsDeadZonesModule } from '../gps-dead-zones/gps-dead-zones.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TrackerFixModeModule } from '../tracker-fix-mode/tracker-fix-mode.module';
import { TripsModule } from '../trips/trips.module';
import { AdminSamplingController } from './admin-sampling.controller';
import { DataRetentionService } from './data-retention.service';
import { RetentionController } from './retention.controller';
import { RetentionStatsService } from './retention-stats.service';
import { IgnitionInferredCleanupService } from './ignition-inferred-cleanup.service';
import { PositionBatchBufferService } from './position-batch-buffer.service';
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
    // TRK-028 — l'ingestion referme les episodes de perte GPS. Pas de `forwardRef` :
    // GpsDeadZonesModule n'importe pas PositionsModule, il n'y a donc pas de cycle.
    GpsDeadZonesModule,
    AuthModule,
  ],
  controllers: [PositionsController, AdminSamplingController, RetentionController],
  providers: [
    PositionsService,
    PositionSamplingService,
    PositionHistoryService,
    PositionBatchBufferService,
    IgnitionInferredCleanupService,
    DataRetentionService,
    RetentionStatsService,
  ],
  exports: [PositionsService, PositionSamplingService, PositionHistoryService],
})
export class PositionsModule {}
