import {
  Body,
  Controller,
  NotImplementedException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireVehiclePermission } from '../auth/decorators/vehicle-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AudioMonitoringGuard } from './audio-monitoring.guard';
import { RequestListenDto } from './dto/request-listen.dto';

/**
 * Sprint 4 — Écoute audio à distance (Phase 2 : SÉCURITÉ uniquement).
 *
 * ⚠️ Squelette intentionnel : seuls les DÉCORATEURS (chaîne de guards + rôles +
 * permission per-véhicule) sont posés et testés (audio-monitoring.security.spec).
 * Le corps lève NotImplementedException — le dispatch device (mocké), les modèles,
 * le mail d'obligations et l'UI arrivent en Phase 3, APRÈS revue humaine du bloc
 * sécurité (cf. docs/sprint-4/PLAN.md §4).
 *
 * Ordre des guards (legal-critical) :
 *   classe → JwtAuthGuard (auth)
 *   listen → RolesGuard (FLEET_ADMIN | SUPER_ADMIN)
 *          → AudioMonitoringGuard (pivot dev/prod, #2/#3)
 *          → PermissionsGuard (audio_monitoring résolu per-véhicule, #1)
 */
@Controller('audio-monitoring')
@UseGuards(JwtAuthGuard)
export class AudioMonitoringController {
  /**
   * POST /audio-monitoring/trackers/:trackerId/listen — déclenche une écoute.
   * SUPER_ADMIN n'est listé que pour passer le gate en dev/test ; en production
   * l'AudioMonitoringGuard le bloque (#3) et exige le flag (#2).
   */
  @Post('trackers/:trackerId/listen')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard, AudioMonitoringGuard)
  @RequireVehiclePermission('audio_monitoring', { paramName: 'trackerId' })
  @UseGuards(PermissionsGuard)
  listen(@Param('trackerId') _trackerId: string, @Body() _dto: RequestListenDto): never {
    // Phase 3 : créer AudioMonitoringCommand (audit) + dispatch device MOCKÉ.
    throw new NotImplementedException('Phase 3');
  }
}
