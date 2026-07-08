import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EngineControlModule } from '../engine-control/engine-control.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { VehicleAccessModule } from '../vehicle-access/vehicle-access.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { FleetSchedulesController } from './fleet-schedules.controller';
import { FleetSchedulesService } from './fleet-schedules.service';
import { ScheduleCronService } from './schedule-cron.service';
import { VehicleSchedulesController } from './vehicle-schedules.controller';
import { VehicleSchedulesService } from './vehicle-schedules.service';

@Module({
  imports: [
    AuthModule,
    EngineControlModule,
    // Demande CDEF (2026-07) — page flotte : snapshot scopé/caché (VehiclesModule), permission
    // par véhicule (PermissionsModule) et périmètre d'accès (VehicleAccessModule).
    VehiclesModule,
    PermissionsModule,
    VehicleAccessModule,
  ],
  controllers: [VehicleSchedulesController, FleetSchedulesController],
  providers: [VehicleSchedulesService, ScheduleCronService, FleetSchedulesService],
})
export class VehicleSchedulesModule {}
