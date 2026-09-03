import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TripAnalysisModule } from '../trip-analysis/trip-analysis.module';
import { BackgroundTasksController } from './background-tasks.controller';
import { BackgroundTasksService } from './background-tasks.service';

/**
 * Demande CDEF (2026-07) — inventaire des traitements de fond (crons/timers).
 * SchedulerRegistry est fourni globalement par ScheduleModule.forRoot() (app.module) → injectable ici.
 */
// `TripAnalysisModule` : l'écran lit le reste à faire des récits par `TripAutomationService`.
// Aucun cycle — TripAnalysisModule n'importe pas ce module.
@Module({
  imports: [AuthModule, TripAnalysisModule],
  controllers: [BackgroundTasksController],
  providers: [BackgroundTasksService],
})
export class BackgroundTasksModule {}
