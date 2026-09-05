import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TripAnalysisModule } from '../trip-analysis/trip-analysis.module';
import { AgentsLocauxSentinelleService } from './agents-locaux-sentinelle.service';
import { BackgroundTasksController } from './background-tasks.controller';
import { BackgroundTasksService } from './background-tasks.service';

/**
 * Demande CDEF (2026-07) — inventaire des traitements de fond (crons/timers).
 * SchedulerRegistry est fourni globalement par ScheduleModule.forRoot() (app.module) → injectable ici.
 */
// `TripAnalysisModule` : l'écran lit le reste à faire des récits par `TripAutomationService`.
// Aucun cycle — TripAnalysisModule n'importe pas ce module.
// `NotificationsModule` : la sentinelle des agents du poste prévient les super-admins par le socle
// générique `notifyUsers` (mêmes préférences, même anti-spam, même journal que tout autre envoi).
// ErrorLogger et RefroidissementAlerteService viennent d'ObservabilityModule, qui est @Global.
@Module({
  imports: [AuthModule, TripAnalysisModule, NotificationsModule],
  controllers: [BackgroundTasksController],
  providers: [
    BackgroundTasksService,
    // PS du chantier C3 (2026-09-05) : « PC éteint la nuit = le matin, tous les agents en échec ».
    // Elle LIT le catalogue ci-dessus et ÉCRIT au centre d'alerte — la seule voie par laquelle un
    // agent du poste qui ne tourne pas cesse d'être silencieux.
    AgentsLocauxSentinelleService,
  ],
})
export class BackgroundTasksModule {}
