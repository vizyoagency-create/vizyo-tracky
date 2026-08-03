import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { AdminLogsController } from './admin-logs.controller';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { CobanWireLogger } from './coban-wire-logger.service';
import { DependencyHeartbeatService } from './dependency-heartbeat.service';
import { ScheduledTaskHeartbeatService } from './scheduled-task-heartbeat.service';
import { ErrorLogger } from './error-logger.service';
import { ErrorRateWatchdogService } from './error-rate-watchdog.service';
import { LogCleanupService } from './log-cleanup.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [AdminLogsController],
  providers: [
    CobanWireLogger,
    ErrorLogger,
    // Vigie de saturation : EmailService vient d'EmailModule (@Global) → pas d'import croisé.
    ErrorRateWatchdogService,
    // Sonde active des dépendances : détecte les pannes SILENCIEUSES (une dépendance morte mais
    // non sollicitée n'écrit aucune erreur, donc la vigie de volume ci-dessus reste muette).
    DependencyHeartbeatService,
    // Sonde des taches PLANIFIEES : une tache a l arret ne produit aucun evenement,
    // donc aucune alerte. Il faut aller chercher son silence (incident du 2026-08-03).
    ScheduledTaskHeartbeatService,
    LogCleanupService,
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
  exports: [CobanWireLogger, ErrorLogger],
})
export class ObservabilityModule {}
