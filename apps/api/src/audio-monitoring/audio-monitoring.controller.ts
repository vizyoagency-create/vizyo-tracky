import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireVehiclePermission } from '../auth/decorators/vehicle-permissions.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AudioMonitoringGuard } from './audio-monitoring.guard';
import { AudioMonitoringService } from './audio-monitoring.service';
import { RequestListenDto } from './dto/request-listen.dto';
import { SetFleetAudioConfigDto } from './dto/set-fleet-audio-config.dto';

/**
 * Sprint 4 — Écoute audio à distance (micro embarqué). LÉGALEMENT CRITIQUE.
 *
 * Scénario A confirmé (cf. docs/sprint-4) : l'« écoute » = le boîtier ouvre son micro
 * et le fleet-admin APPELLE la SIM pour entendre la cabine en direct. Le serveur GATE
 * + AUDITe + (mock-)ARM le micro ; aucun clip n'est reçu/stocké côté serveur. Le device
 * est MOCKÉ dans le service — aucune trame n'est envoyée à un boîtier réel.
 *
 * Ordre des guards (legal-critical) :
 *   classe → JwtAuthGuard (auth)
 *   listen → RolesGuard (FLEET_ADMIN | SUPER_ADMIN)
 *          → AudioMonitoringGuard (pivot dev/prod, #2/#3)
 *          → PermissionsGuard (audio_monitoring résolu per-véhicule, #1)
 *   config → RolesGuard + AudioMonitoringGuard
 *   audit  → RolesGuard
 */
@Controller('audio-monitoring')
@UseGuards(JwtAuthGuard)
export class AudioMonitoringController {
  constructor(private readonly audio: AudioMonitoringService) {}

  /**
   * POST /audio-monitoring/trackers/:trackerId/listen — déclenche une écoute.
   * SUPER_ADMIN n'est listé que pour passer le gate en dev/test ; en production
   * l'AudioMonitoringGuard le bloque (#3) et exige le flag (#2).
   * Retourne la commande (audit) + le n° SIM à appeler (Scénario A appel live).
   */
  @Post('trackers/:trackerId/listen')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard, AudioMonitoringGuard)
  @RequireVehiclePermission('audio_monitoring', { paramName: 'trackerId' })
  @UseGuards(PermissionsGuard)
  listen(
    @Param('trackerId') trackerId: string,
    @Body() dto: RequestListenDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.audio.requestListen(trackerId, dto.reason, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  /**
   * PATCH /audio-monitoring/fleets/:fleetId/config — active/désactive l'écoute pour
   * une flotte. Activer EXIGE l'attestation (#5) ; à l'activation un mail OBLIGATIONS
   * part à tous les users actifs (#6). Un FLEET_ADMIN ne configure que SA flotte.
   */
  @Patch('fleets/:fleetId/config')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard, AudioMonitoringGuard)
  setFleetConfig(
    @Param('fleetId') fleetId: string,
    @Body() dto: SetFleetAudioConfigDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.audio.setFleetAudioConfig(
      fleetId,
      {
        enabled: dto.enabled,
        attestation: dto.attestation,
        attestationVersion: dto.attestationVersion,
      },
      { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId },
    );
  }

  /**
   * GET /audio-monitoring/audit — historique des écoutes (qui/quand/véhicule/motif).
   * Tenant-scopé : SUPER_ADMIN voit tout ; FLEET_ADMIN sa flotte.
   */
  @Get('audit')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard)
  audit(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('status') status?: string,
  ) {
    return this.audio.getAudit(
      { limit: limit ? parseInt(limit, 10) || 50 : 50, before, status },
      { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId },
    );
  }
}
