import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PartnerPairingService } from './partner-pairing.service';

/**
 * Écran « Intégrations » du client (fleet-admin). C'est ICI que vit l'interrupteur :
 * Tracky est le fournisseur, il décide de ce qui est partagé et peut tout couper.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §8.2
 */
@Controller('integrations/partner')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class PartnerController {
  constructor(private readonly pairing: PartnerPairingService) {}

  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('integrations_manage')
  async status(@Req() req: AuthenticatedRequest) {
    return this.pairing.status(this.requireFleet(req));
  }

  /** Résout un code et renvoie l'aperçu du consentement. N'active RIEN. */
  @Post('claim')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('integrations_manage')
  async claim(@Req() req: AuthenticatedRequest, @Body() body: { code?: string }) {
    if (!body?.code) throw new BadRequestException('Code requis');
    return this.pairing.claim(this.requireFleet(req), body.code);
  }

  /** Acte explicite du fleet-admin : active le partage sur les catégories cochées. */
  @Post('approve')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('integrations_manage')
  async approve(@Req() req: AuthenticatedRequest, @Body() body: { code?: string; scopes?: unknown }) {
    if (!body?.code) throw new BadRequestException('Code requis');
    return this.pairing.approve(this.requireFleet(req), req.user.id, body.code, body.scopes);
  }

  /**
   * Le lien appartient à une FLOTTE : un super-admin sans flotte n'a rien à
   * appairer. On refuse plutôt que de deviner laquelle.
   */
  private requireFleet(req: AuthenticatedRequest): string {
    if (!req.user.fleetId) throw new BadRequestException('Aucune flotte associee a ce compte');
    return req.user.fleetId;
  }
}
