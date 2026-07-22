import { BadRequestException, Body, Controller, Delete, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { isPartnerScope } from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PartnerOutboxService } from './partner-outbox.service';
import { PartnerPairingService } from './partner-pairing.service';
import { PartnerRevocationService } from './partner-revocation.service';

/**
 * Écran « Intégrations » du client (fleet-admin). C'est ICI que vit l'interrupteur :
 * Tracky est le fournisseur, il décide de ce qui est partagé et peut tout couper.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §8.2
 */
@Controller('integrations/partner')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class PartnerController {
  constructor(
    private readonly pairing: PartnerPairingService,
    private readonly revocation: PartnerRevocationService,
    private readonly outbox: PartnerOutboxService,
  ) {}

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
   * L'INTERRUPTEUR VIVANT (décision D3) : allumer ou éteindre une catégorie à tout
   * moment, indépendamment des autres. Éteindre purge cette catégorie chez le
   * partenaire, sans toucher au reste.
   */
  @Patch('scopes')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('integrations_manage')
  async setScope(@Req() req: AuthenticatedRequest, @Body() body: { scope?: string; enabled?: boolean }) {
    if (!body?.scope || !isPartnerScope(body.scope)) throw new BadRequestException('Scope inconnu');
    if (typeof body.enabled !== 'boolean') throw new BadRequestException('`enabled` requis');

    const link = await this.pairing.requireLink(this.requireFleet(req));
    const result = await this.revocation.setScope(link.id, body.scope, body.enabled, req.user.id);
    // Tentative immédiate ; le cron de l'outbox reste le filet.
    if (result.changed && !body.enabled) await this.outbox.dispatchNow(link.id);
    return result;
  }

  /**
   * Révocation par le CLIENT. Terminal : on ne réactive pas, on refait un
   * handshake (ce qui reconstruit le consentement).
   */
  @Delete()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('integrations_manage')
  async revoke(@Req() req: AuthenticatedRequest, @Body() body: { reason?: string }) {
    const fleetId = this.requireFleet(req);
    const link = await this.pairing.requireLink(fleetId);
    const result = await this.revocation.revoke(
      link.id,
      body?.reason?.slice(0, 200) || 'Revoque par le client',
      'USER',
      req.user.id,
    );
    // Tentative immédiate ; le cron de l'outbox reste le filet si elle échoue.
    await this.outbox.dispatchNow(link.id);
    return result;
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
