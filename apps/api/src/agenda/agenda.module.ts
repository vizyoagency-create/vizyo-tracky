import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AgendaController } from './agenda.controller';
import { AgendaOptimizationController } from './agenda-optimization.controller';
import { AgendaOptimizationService } from './agenda-optimization.service';
import { FleetInsightsController } from './fleet-insights.controller';
import { FleetInsightsService } from './fleet-insights.service';
import { ForecastService } from './forecast.service';
import { MaintenancePlansService } from './maintenance-plans.service';
import { MaintenanceReminderService } from './maintenance-reminder.service';
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
  controllers: [AgendaController, AgendaOptimizationController, FleetInsightsController, ReservationsController],
  providers: [
    VehicleEventsService,
    MaintenancePlansService,
    MaintenanceReminderService,
    FleetInsightsService,
    ReservationsService,
    ForecastService,
    AgendaOptimizationService,
  ],
  exports: [VehicleEventsService, FleetInsightsService, ReservationsService, ForecastService, AgendaOptimizationService],
})
export class AgendaModule {}
