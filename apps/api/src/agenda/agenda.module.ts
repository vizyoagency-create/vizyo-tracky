import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AgendaController } from './agenda.controller';
import { MaintenancePlansService } from './maintenance-plans.service';
import { MaintenanceReminderService } from './maintenance-reminder.service';
import { VehicleEventsService } from './vehicle-events.service';

/**
 * Sprint 7 — Agenda générique (maintenance + incidents ; fondation Sprint 8 réservations).
 * VehicleAccessService + PrismaService sont globaux. NotificationsModule fournit WebPushService
 * (rappels). AuthModule fournit les guards (Jwt/Roles/Permissions).
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [AgendaController],
  providers: [VehicleEventsService, MaintenancePlansService, MaintenanceReminderService],
  exports: [VehicleEventsService],
})
export class AgendaModule {}
