import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TrackerCommandsModule } from '../tracker-commands/tracker-commands.module';
import { SurveillanceController } from './surveillance.controller';
import { SurveillanceSchedulerService } from './surveillance-scheduler.service';
import { SurveillanceService } from './surveillance.service';

/**
 * V1.6 — Module Surveillance Max.
 *
 * Permet de mettre un véhicule sous surveillance renforcée (manuellement ou
 * sur plage horaire). Quand le profile est armé, toute trame d'alarme matchant
 * les triggers actifs (vibration / mouvement / porte) déclenche une alerte
 * CRITICAL `SURVEILLANCE_TRIGGERED` et un `SurveillanceEvent` historique.
 *
 * Le branchement de l'élévation severity se fait côté `AlertsService.createFromCobanFrame()`
 * (lecture du profile + appel à `SurveillanceService.recordTrigger()`). On évite
 * ainsi une dépendance circulaire AlertsModule ⇄ SurveillanceModule en exportant
 * uniquement `SurveillanceService` ici.
 */
@Module({
  imports: [AuthModule, TrackerCommandsModule],
  controllers: [SurveillanceController],
  providers: [SurveillanceService, SurveillanceSchedulerService],
  exports: [SurveillanceService],
})
export class SurveillanceModule {}
