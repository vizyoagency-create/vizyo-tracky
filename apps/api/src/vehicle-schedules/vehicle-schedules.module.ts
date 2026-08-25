import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { AuthModule } from '../auth/auth.module';
import { EngineControlModule } from '../engine-control/engine-control.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { VehicleAccessModule } from '../vehicle-access/vehicle-access.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { FleetSchedulesController } from './fleet-schedules.controller';
import { FleetSchedulesService } from './fleet-schedules.service';
import { ScheduleCronService } from './schedule-cron.service';
import { SortieHorsHoraireService } from './sortie-hors-horaire.service';
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
    // TRK-046 — l'alerte « sortie hors horaire » naît dans CE module (il connaît les
    // plannings) et se diffuse via AlertsService. Aucun cycle : alerts n'importe que
    // Auth/Realtime/Notifications.
    AlertsModule,
  ],
  controllers: [VehicleSchedulesController, FleetSchedulesController],
  providers: [VehicleSchedulesService, ScheduleCronService, FleetSchedulesService, SortieHorsHoraireService],
})
export class VehicleSchedulesModule {}
