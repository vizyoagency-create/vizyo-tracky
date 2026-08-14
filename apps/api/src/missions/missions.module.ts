import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MissionPricingService } from './mission-pricing.service';
import { MissionRequestsController } from './mission-requests.controller';
import { MissionRequestsService } from './mission-requests.service';
import { MissionStatusService } from './mission-status.service';
import { MissionsController } from './missions.controller';
import { MissionsService } from './missions.service';

/**
 * Espace depot (2026-08) — lot A2. Cf. design/A2-MISSIONS.md.
 *
 * `AuthModule` est importe explicitement : le controleur emploie `JwtAuthGuard`. Un
 * `imports:` manquant ne se voit ni au typecheck ni aux tests unitaires — c'est la
 * panne du 22/07/2026 que le smoke-boot attrape.
 *
 * `RealtimeModule` (lot A3) : la cloture d'une mission doit couper le direct du depot
 * AVEC une explication. Sans elle, un camion disparait de sa carte sans un mot.
 */
@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [MissionsController, MissionRequestsController],
  providers: [MissionsService, MissionStatusService, MissionPricingService, MissionRequestsService],
  exports: [MissionsService, MissionPricingService, MissionRequestsService],
})
export class MissionsModule {}
