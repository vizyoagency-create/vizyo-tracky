import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BackgroundTasksController } from './background-tasks.controller';
import { BackgroundTasksService } from './background-tasks.service';

/**
 * Demande CDEF (2026-07) — inventaire des traitements de fond (crons/timers).
 * SchedulerRegistry est fourni globalement par ScheduleModule.forRoot() (app.module) → injectable ici.
 */
@Module({
  imports: [AuthModule],
  controllers: [BackgroundTasksController],
  providers: [BackgroundTasksService],
})
export class BackgroundTasksModule {}
