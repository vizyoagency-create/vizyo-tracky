import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { AdminLogsController } from './admin-logs.controller';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { CentreAlerteWikiController } from './centre-alerte-wiki.controller';
import { CentreAlerteWikiService } from './centre-alerte-wiki.service';
import { CobanWireLogger } from './coban-wire-logger.service';
import { DependencyHeartbeatService } from './dependency-heartbeat.service';
import { ScheduledTaskHeartbeatService } from './scheduled-task-heartbeat.service';
import { ErrorLogger } from './error-logger.service';
import { ErrorRateWatchdogService } from './error-rate-watchdog.service';
import { LogCleanupService } from './log-cleanup.service';
import { VpsAuditWikiController } from './vps-audit-wiki.controller';
import { VpsAuditWikiService } from './vps-audit-wiki.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [AdminLogsController, CentreAlerteWikiController, VpsAuditWikiController],
  providers: [
    CobanWireLogger,
    ErrorLogger,
    // Documentation du centre d'alerte (référentiel, procédure, rapports d'audit) servie à
    // l'écran admin : on veut ces documents SOUS LES YEUX au moment où l'on regarde une alerte.
    CentreAlerteWikiService,
    // Documentation de l'audit VPS (constats, procédure, rapports) : même mécanique, autre
    // objet — ce que la MACHINE subit, là où le centre d'alerte dit ce que l'app casse.
    VpsAuditWikiService,
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
