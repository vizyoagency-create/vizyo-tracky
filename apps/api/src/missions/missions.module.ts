import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MissionStatusService } from './mission-status.service';
import { MissionsController } from './missions.controller';
import { MissionsService } from './missions.service';

/**
 * Espace depot (2026-08) — lot A2. Cf. design/A2-MISSIONS.md.
 *
 * `AuthModule` est importe explicitement : le controleur emploie `JwtAuthGuard`. Un
 * `imports:` manquant ne se voit ni au typecheck ni aux tests unitaires — c'est la
 * panne du 22/07/2026 que le smoke-boot attrape.
 */
@Module({
  imports: [AuthModule],
  controllers: [MissionsController],
  providers: [MissionsService, MissionStatusService],
  exports: [MissionsService],
})
export class MissionsModule {}
