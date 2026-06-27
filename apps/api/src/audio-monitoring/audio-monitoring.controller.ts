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
import { SetFleetEligibilityDto } from './dto/set-fleet-eligibility.dto';

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
 *   listen      → RolesGuard (SUPER_ADMIN, phase de test)
 *               → AudioMonitoringGuard (pivot dev/prod, #2/#3)
 *               → PermissionsGuard (audio_monitoring résolu per-véhicule, #1)
 *   eligibility → RolesGuard (SUPER_ADMIN) + AudioMonitoringGuard   (N1 prestataire)
 *   config      → RolesGuard (FLEET_ADMIN | SUPER_ADMIN) + AudioMonitoringGuard (N2 consentement)
 *   fleets      → RolesGuard (SUPER_ADMIN)  (vue éligibilité, lecture)
 *   audit       → RolesGuard
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
  // Sprint 4 — phase de test SUPER_ADMIN only ; rouvrir a FLEET_ADMIN ensuite.
  @Roles(UserRole.SUPER_ADMIN)
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
   * POST /audio-monitoring/trackers/:trackerId/stop — DÉSARME le micro (retour mode track).
   * CRITIQUE : le mode monitor coupe le report GPS, donc le désarmement remet le véhicule
   * « visible » sur la carte. Même gate que `listen` (SUPER_ADMIN, phase de test ; #2/#3 via
   * AudioMonitoringGuard). Envoie `tracker<password>` à la SIM + pose disarmedAt sur l'écoute
   * armée la plus récente du tracker.
   */
  @Post('trackers/:trackerId/stop')
  @Roles(UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard, AudioMonitoringGuard)
  stop(@Param('trackerId') trackerId: string, @Req() req: AuthenticatedRequest) {
    return this.audio.stopListen(trackerId, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  /**
   * PATCH /audio-monitoring/fleets/:fleetId/eligibility — N1 : le super-admin/prestataire
   * rend une flotte ÉLIGIBLE (ou non) au « Mode assistance ». `eligible:false` cascade
   * « tout OFF » (le consentement N2 de la flotte est aussi remis à false). SUPER_ADMIN only.
   */
  @Patch('fleets/:fleetId/eligibility')
  @Roles(UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard, AudioMonitoringGuard)
  setFleetEligibility(
    @Param('fleetId') fleetId: string,
    @Body() dto: SetFleetEligibilityDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.audio.setFleetEligibility(fleetId, dto.eligible, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  /**
   * PATCH /audio-monitoring/fleets/:fleetId/config — N2 : le fleet-admin active/désactive
   * son « Mode assistance ». Refusé si la flotte n'est pas éligible (N1). Activer EXIGE
   * l'attestation (#5) ; à l'activation un mail OBLIGATIONS part à tous les users actifs
   * (#6, sauf bascule super-admin). Un FLEET_ADMIN ne configure que SA flotte.
   */
  @Patch('fleets/:fleetId/config')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard, AudioMonitoringGuard)
  setFleetConfig(
    @Param('fleetId') fleetId: string,
    @Body() dto: SetFleetAudioConfigDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.audio.setFleetAssistanceMode(
      fleetId,
      {
        assistanceEnabled: dto.assistanceEnabled,
        attestation: dto.attestation,
        attestationVersion: dto.attestationVersion,
      },
      { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId },
    );
  }

  /**
   * GET /audio-monitoring/fleets/:fleetId/config — état d'activation de l'écoute pour
   * une flotte (écran d'activation). Lecture seule → PAS d'AudioMonitoringGuard (comme
   * l'audit GET) ; un FLEET_ADMIN ne consulte que SA flotte (tenant-checké en service).
   */
  @Get('fleets/:fleetId/config')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard)
  getFleetConfig(@Param('fleetId') fleetId: string, @Req() req: AuthenticatedRequest) {
    return this.audio.getFleetAudioConfig(fleetId, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  /**
   * GET /audio-monitoring/fleets — vue super-admin de l'éligibilité audio : TOUTES les
   * flottes avec leur état (superAdminEnabled N1 / assistanceEnabled N2). Lecture seule
   * → PAS d'AudioMonitoringGuard (comme les autres GET). SUPER_ADMIN only.
   */
  @Get('fleets')
  @Roles(UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard)
  getFleets(@Req() req: AuthenticatedRequest) {
    return this.audio.getFleetsWithAudio({
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  /**
   * POST /audio-monitoring/users/:userId/info-mail — envoie À LA DEMANDE le mail
   * d'INFORMATION « Mode assistance » à un utilisateur (typiquement un fleet-admin, ex:
   * onboarding client). SUPER_ADMIN only (le prestataire présente la fonction avant
   * activation). Lecture/écriture de notif uniquement → pas d'AudioMonitoringGuard.
   */
  @Post('users/:userId/info-mail')
  @Roles(UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard)
  sendAudioInfoMail(@Param('userId') userId: string, @Req() req: AuthenticatedRequest) {
    return this.audio.sendAudioInfoMail(userId, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
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
