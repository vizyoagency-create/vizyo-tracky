import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DriversModule } from '../drivers/drivers.module';
import { DriverUnlockModule } from '../driver-unlock/driver-unlock.module';
import { GpsDeadZonesModule } from '../gps-dead-zones/gps-dead-zones.module';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

@Module({
  // TRK-046 — GpsDeadZonesModule : présomption de stationnement dans les DTO (liste, fiche,
  // snapshot). Pas de cycle : gps-dead-zones n'importe qu'AuthModule.
  imports: [AuthModule, DriversModule, DriverUnlockModule, GpsDeadZonesModule],
  controllers: [VehiclesController],
  providers: [VehiclesService],
  exports: [VehiclesService],
})
export class VehiclesModule {}
