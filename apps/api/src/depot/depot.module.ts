import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DepotController } from './depot.controller';
import { DepotScopeGuard } from './depot-scope.guard';
import { DepotScopeService } from './depot-scope.service';
import { DepotService } from './depot.service';

/**
 * Espace depot (2026-08) — lot A1 : le perimetre et son garde.
 *
 * Module GLOBAL, sur le modele de `PermissionsModule`. La raison n'est pas la
 * commodite : `DepotScopeGuard` doit pouvoir etre pose sur des controleurs qui
 * existaient DEJA (`positions`, `trips`) sans forcer chacun d'eux a importer un
 * module de plus. Une route qu'on oublie de brancher est une faille — on retire
 * donc l'occasion d'oublier.
 *
 * Le controleur ne porte que les TROIS routes qui rendent l'isolation verifiable
 * (liste, detail, position). Les cinq autres d'A1 § 4 — historique, exports,
 * documents, incidents — arrivent avec leurs ecrans au lot A3.
 *
 * `AuthModule` est importe explicitement : le controleur emploie `JwtAuthGuard`, et
 * un `imports:` manquant ne se voit ni au typecheck ni aux tests unitaires — c'est
 * exactement la panne du 22/07/2026 que le smoke-boot attrape.
 *
 * Cf. design/A1-ROLE-DEPOT.md.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [DepotController],
  providers: [DepotScopeService, DepotScopeGuard, DepotService],
  exports: [DepotScopeService, DepotScopeGuard, DepotService],
})
export class DepotModule {}
