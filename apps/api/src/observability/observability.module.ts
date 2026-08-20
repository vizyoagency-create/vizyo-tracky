import { RecuperationController } from './recuperation.controller';
import { RecuperationService } from './recuperation.service';
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
import { RecensementSuppressionsService } from './recensement-suppressions.service';
import { VpsAuditWikiController } from './vps-audit-wiki.controller';
import { VpsAuditWikiService } from './vps-audit-wiki.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [AdminLogsController, CentreAlerteWikiController, VpsAuditWikiController, RecuperationController],
  providers: [
    CobanWireLogger,
    // Tableau de ce que chaque couche d'enrichissement a REELLEMENT recupere : sans lui,
    // une couche peut echouer en silence (98,8 % du cache des limites etait faux, invisible).
    RecuperationService,
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
    // TRK-035 — recensement quotidien des lignes conservees. Aucun code ne peut empecher un
    // DELETE fait directement en base ; celui-ci ne l'empeche pas non plus, il empeche qu'il
    // passe INAPERCU. 41 709 alertes ont disparu le 2026-08-19 sans qu'aucun journal ne le dise.
    RecensementSuppressionsService,
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
  exports: [CobanWireLogger, ErrorLogger],
})
export class ObservabilityModule {}
