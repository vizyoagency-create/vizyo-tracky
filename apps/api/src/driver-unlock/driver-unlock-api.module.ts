import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EngineControlModule } from '../engine-control/engine-control.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { DriverUnlockController } from './driver-unlock.controller';
import { DriverUnlockService } from './driver-unlock.service';
import { DriverUnlockModule } from './driver-unlock.module';

/**
 * feat/comptes-conducteurs (4b) — endpoint `POST /driver/unlock`.
 *
 * Module SÉPARÉ du `DriverUnlockModule` (léger, jetons, importé par VehiclesModule) pour éviter
 * un cycle DI : celui-ci importe EngineControlModule (RESTORE) et n'est importé QUE par AppModule.
 * PrismaModule / ConfigModule sont globaux ; PermissionsModule fournit le résolveur per-véhicule.
 */
@Module({
  imports: [AuthModule, PermissionsModule, EngineControlModule, DriverUnlockModule],
  controllers: [DriverUnlockController],
  providers: [DriverUnlockService],
})
export class DriverUnlockApiModule {}
