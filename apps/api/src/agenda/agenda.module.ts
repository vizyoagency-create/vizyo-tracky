import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnthropicClient } from '../ai/anthropic.client';
import { NotificationsModule } from '../notifications/notifications.module';
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
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { VehicleEventsService } from './vehicle-events.service';

/**
 * Sprint 7 — Agenda générique (maintenance + incidents ; fondation Sprint 8 réservations).
 * VehicleAccessService + PrismaService sont globaux. NotificationsModule fournit WebPushService
 * (rappels). AuthModule fournit les guards (Jwt/Roles/Permissions).
 */
@Module({
  imports: [AuthModule, NotificationsModule],
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
    AgendaAgentRunnerService,
    // Fourni LOCALEMENT (anti-cycle AgendaModule↔AiModule) : couche IA best-effort de l'agent.
    AnthropicClient,
  ],
  exports: [VehicleEventsService, FleetInsightsService, ReservationsService, ForecastService],
})
export class AgendaModule {}
