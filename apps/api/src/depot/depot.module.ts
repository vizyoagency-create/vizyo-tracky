import { Global, Module } from '@nestjs/common';
import { TripStopDetectorService } from '../agenda/trip-stop-detector.service';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { DepotDocumentsService } from './depot-documents.service';
import { DepotExportService } from './depot-export.service';
import { DepotHistoryService } from './depot-history.service';
import { DepotIncidentService } from './depot-incident.service';
import { DepotLiveService } from './depot-live.service';
import { DepotController } from './depot.controller';
import { DepotScopeGuard } from './depot-scope.guard';
import { DepotScopeService } from './depot-scope.service';
import { DepotTripService } from './depot-trip.service';
import { DepotService } from './depot.service';

/**
 * Espace depot (2026-08) — le perimetre, son garde, et les huit routes.
 *
 * Module GLOBAL, sur le modele de `PermissionsModule`. La raison n'est pas la
 * commodite : `DepotScopeGuard` doit pouvoir etre pose sur des controleurs qui
 * existaient DEJA (`positions`, `trips`) sans forcer chacun d'eux a importer un
 * module de plus. Une route qu'on oublie de brancher est une faille — on retire
 * donc l'occasion d'oublier.
 *
 * `AuthModule` est importe explicitement : le controleur emploie `JwtAuthGuard`, et
 * un `imports:` manquant ne se voit ni au typecheck ni aux tests unitaires — c'est
 * exactement la panne du 22/07/2026 que le smoke-boot attrape.
 *
 * ⚠️ `TripStopDetectorService` est fourni ICI plutot qu'importe depuis `AgendaModule`.
 * Ce module est `@Global` et charge tot ; importer `AgendaModule` — qui tire
 * reservations, prevision et l'agent IA — pour un detecteur sans etat qui ne depend
 * que de Prisma echangerait une dependance de 3 lignes contre un graphe entier, et
 * un risque de cycle. Le service est idempotent : deux instances ne coutent rien.
 *
 * Cf. design/A1-ROLE-DEPOT.md et design/A3-ESPACE-DEPOT.md.
 */
@Global()
@Module({
  imports: [AuthModule, EmailModule],
  controllers: [DepotController],
  providers: [
    DepotScopeService,
    DepotScopeGuard,
    DepotService,
    DepotLiveService,
    DepotHistoryService,
    DepotTripService,
    DepotDocumentsService,
    DepotExportService,
    DepotIncidentService,
    TripStopDetectorService,
  ],
  exports: [DepotScopeService, DepotScopeGuard, DepotService, DepotLiveService],
})
export class DepotModule {}
