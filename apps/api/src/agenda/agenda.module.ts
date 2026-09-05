import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TravauxIaModule } from '../travaux-ia/travaux-ia.module';
import { AgendaAgentController } from './agenda-agent.controller';
import { AgendaAgentRunnerService } from './agenda-agent-runner.service';
import { AgendaAgentSettingsController } from './agenda-agent-settings.controller';
import { AgendaAgentSettingsService } from './agenda-agent-settings.service';
import { AgendaController } from './agenda.controller';
import { FleetInsightsController } from './fleet-insights.controller';
import { FleetInsightsService } from './fleet-insights.service';
import { ForecastService } from './forecast.service';
import { MaintenancePlansService } from './maintenance-plans.service';
import { MaintenanceReminderService } from './maintenance-reminder.service';
import { RecurrenceDetectorService } from './recurrence-detector.service';
import { TripStopDetectorService } from './trip-stop-detector.service';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { VehicleEventsService } from './vehicle-events.service';

/**
 * Sprint 7 — Agenda générique (maintenance + incidents ; fondation Sprint 8 réservations).
 * VehicleAccessService + PrismaService sont globaux. NotificationsModule fournit WebPushService
 * (rappels). AuthModule fournit les guards (Jwt/Roles/Permissions).
 *
 * TravauxIaModule (design/C3 point 7, 2026-09-05) : le jugement de l'agent d'agenda passe par la
 * file du poste — `AgendaAgentRunnerService` y enfile un travail `jugement-agenda` par passage et
 * consomme les verdicts au cron horaire. `AiUsageService` (ligne d'usage du verdict),
 * `AiAvailabilityService` (porte IA par société) et `ErrorLogger` viennent de modules `@Global`
 * (AiUsageModule, AiCoreModule, ObservabilityModule) : rien à importer pour eux.
 */
@Module({
  imports: [AuthModule, NotificationsModule, TravauxIaModule],
  controllers: [
    AgendaController,
    FleetInsightsController,
    ReservationsController,
    AgendaAgentSettingsController,
    AgendaAgentController,
  ],
  providers: [
    VehicleEventsService,
    MaintenancePlansService,
    MaintenanceReminderService,
    FleetInsightsService,
    ReservationsService,
    ForecastService,
    AgendaAgentSettingsService,
    RecurrenceDetectorService,
    TripStopDetectorService,
    AgendaAgentRunnerService,
  ],
  exports: [VehicleEventsService, FleetInsightsService, ReservationsService, ForecastService],
})
export class AgendaModule {}
