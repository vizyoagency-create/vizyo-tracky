import { Body, Controller, ForbiddenException, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AiFeatureKey, AiStatusDto, FleetAiSettingDto, SetAiEnabledDto } from '@vizyo/tracky-shared';
import { AI_FEATURE_KEYS } from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
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
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class AiStatusController {
  constructor(private readonly aiAvail: AiAvailabilityService) {}

  /**
   * ⚠️ Renvoie la disponibilité PAR FONCTIONNALITÉ, pas un seul booléen.
   *
   * Le serveur cumule trois verrous avant d'accepter un appel IA : clé provider, kill-switch
   * GLOBAL par fonction (owner), interrupteur société. `enabled` n'en reflétait que deux — il
   * ignorait le kill-switch par fonction. Couper `tripAnalysis` pour tout le monde laissait donc
   * le bouton « Générer le récit IA » à l'écran : l'utilisateur cliquait, le serveur refusait.
   *
   * `enabled` est conservé (interrupteur MAÎTRE de la société : « cette société a-t-elle
   * l'option ? ») pour les textes d'explication, mais une AFFORDANCE doit se gater sur `features`.
   */
  @Get('status')
  async status(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string): Promise<AiStatusDto> {
    // Super-admin peut viser une flotte (filtre société) ; sinon la flotte de l'utilisateur.
    const scoped = req.user.role === UserRole.SUPER_ADMIN ? (fleetId || req.user.fleetId || null) : req.user.fleetId;
    const pairs = await Promise.all(
      AI_FEATURE_KEYS.map(async (k) => [k, await this.aiAvail.isEnabledForFleet(scoped, k)] as const),
    );
    return {
      configured: this.aiAvail.isConfigured(),
      enabled: await this.aiAvail.isEnabledForFleet(scoped),
      fleetId: scoped ?? null,
      features: Object.fromEntries(pairs) as Record<AiFeatureKey, boolean>,
    };
  }

  @Get('fleet-enabled')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('ai_configure')
  async getFleetEnabled(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string): Promise<FleetAiSettingDto> {
    const id = this.resolveFleet(req, fleetId);
    return { fleetId: id, enabled: await this.aiAvail.fleetSetting(id) };
  }

  // FACTURATION (2026-07) : l'IA est une OPTION PAYANTE. Un fleet-admin ne l'active PLUS gratuitement
  // ici — il passe par l'abonnement (POST /api/billing/subscribe | request-invoice). Ce toggle
  // bas-niveau reste réservé au SUPER-ADMIN (l'UI owner passe par POST /api/billing/comp → statut COMP).
  @Put('fleet-enabled')
  @Roles(UserRole.SUPER_ADMIN)
  @RequirePermissions('ai_configure')
  async setFleetEnabled(@Req() req: AuthenticatedRequest, @Body() dto: SetAiEnabledDto): Promise<FleetAiSettingDto> {
    const id = this.resolveFleet(req, dto?.fleetId);
    const enabled = await this.aiAvail.setFleet(id, !!dto?.enabled);
    return { fleetId: id, enabled };
  }

  /** Flotte cible : super-admin peut cibler `fleetId` ; fleet-admin est FORCÉ à sa flotte. */
  private resolveFleet(req: AuthenticatedRequest, fleetId?: string): string {
    const isSuper = req.user.role === UserRole.SUPER_ADMIN;
    // fleet-admin : un `fleetId` explicite DOIT être le sien → sinon REJET clair (pas d'application silencieuse).
    if (!isSuper && fleetId && fleetId !== req.user.fleetId) throw new ForbiddenException('Flotte hors périmètre.');
    const id = (isSuper ? fleetId : undefined) ?? req.user.fleetId ?? undefined;
    if (!id) throw new ForbiddenException('Flotte non déterminée.');
    return id;
  }
}
