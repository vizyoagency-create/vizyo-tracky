import { Body, Controller, ForbiddenException, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AiStatusDto, FleetAiSettingDto, SetAiEnabledDto } from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AiAvailabilityService } from './ai-availability.service';

/**
 * IA — état & INTERRUPTEUR MAÎTRE par flotte (2026-07).
 * - GET /api/ai/status : pour TOUT utilisateur authentifié — l'IA est-elle utilisable pour sa flotte ?
 *   (le front masque les actions IA si non). L'analyse déterministe n'est PAS concernée.
 * - GET/PUT /api/ai/fleet-enabled : le fleet-admin active/désactive TOUTE l'IA de SA flotte
 *   (super-admin : n'importe quelle flotte via `fleetId`). Scopé anti-IDOR.
 */
@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AiStatusController {
  constructor(private readonly aiAvail: AiAvailabilityService) {}

  @Get('status')
  async status(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string): Promise<AiStatusDto> {
    // Super-admin peut viser une flotte (filtre société) ; sinon la flotte de l'utilisateur.
    const scoped = req.user.role === UserRole.SUPER_ADMIN ? (fleetId || req.user.fleetId || null) : req.user.fleetId;
    return {
      configured: this.aiAvail.isConfigured(),
      enabled: await this.aiAvail.isEnabledForFleet(scoped),
      fleetId: scoped ?? null,
    };
  }

  @Get('fleet-enabled')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async getFleetEnabled(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string): Promise<FleetAiSettingDto> {
    const id = this.resolveFleet(req, fleetId);
    return { fleetId: id, enabled: await this.aiAvail.fleetSetting(id) };
  }

  @Put('fleet-enabled')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async setFleetEnabled(@Req() req: AuthenticatedRequest, @Body() dto: SetAiEnabledDto): Promise<FleetAiSettingDto> {
    const id = this.resolveFleet(req, dto?.fleetId);
    const enabled = await this.aiAvail.setFleet(id, !!dto?.enabled);
    return { fleetId: id, enabled };
  }

  /** Flotte cible : super-admin peut cibler `fleetId` ; fleet-admin est FORCÉ à sa flotte (défense en profondeur). */
  private resolveFleet(req: AuthenticatedRequest, fleetId?: string): string {
    const id = (req.user.role === UserRole.SUPER_ADMIN ? fleetId : undefined) ?? req.user.fleetId ?? undefined;
    if (!id) throw new ForbiddenException('Flotte non déterminée.');
    if (req.user.role !== UserRole.SUPER_ADMIN && id !== req.user.fleetId) throw new ForbiddenException('Flotte hors périmètre.');
    return id;
  }
}
