import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EngineControlModule } from '../engine-control/engine-control.module';
import { ScheduleCronService } from './schedule-cron.service';
import { VehicleSchedulesController } from './vehicle-schedules.controller';
import { VehicleSchedulesService } from './vehicle-schedules.service';

@Module({
  imports: [AuthModule, EngineControlModule],
  controllers: [VehicleSchedulesController],
  providers: [VehicleSchedulesService, ScheduleCronService],
})
export class VehicleSchedulesModule {}
