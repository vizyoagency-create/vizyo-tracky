import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BILLING_STATUSES, PartnerAdminService, type BillingStatus } from './partner-admin.service';
import { PartnerClientService } from './partner-client.service';
import { PartnerInvitationService } from './partner-invitation.service';
import { PartnerOutboxService } from './partner-outbox.service';

/**
 * Pilotage plateforme des intégrations — SUPER_ADMIN uniquement.
 *
 * ⚠️ Ces routes portent le levier commercial (suspendre un client qui ne paye pas)
 * et la bascule de facturation. Toutes sont journalisées dans `SystemActivityLog` :
 * couper un client a des conséquences financières pour lui, ça doit laisser une trace.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §8.3
 */
@Controller('admin/partner-links')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class PartnerAdminController {
  constructor(
    private readonly admin: PartnerAdminService,
    private readonly outbox: PartnerOutboxService,
    private readonly invitations: PartnerInvitationService,
    private readonly clientApi: PartnerClientService,
  ) {}

  @Get()
  async list() {
    return this.admin.list();
  }

  /**
   * Flottes que l'on peut inviter, avec les adresses des fleet-admins.
   *
   * ⚠️ On PROPOSE les destinataires plutôt que de laisser saisir une adresse au
   * hasard : une invitation envoyée à la mauvaise personne n'est pas une erreur
   * de frappe anodine, c'est une demande de consentement adressée à quelqu'un
   * qui n'a rien à consentir.
   */
  @Get('invitable-fleets')
  async invitableFleets() {
    return this.invitations.invitableFleets();
  }

  /** Journal des sollicitations — alimente l'onglet Sécu & RGPD. */
  @Get('invitations')
  async listInvitations() {
    return this.invitations.list();
  }

  @Post('invitations')
  async invite(
    @Body() body: { fleetId?: string; pairingCode?: string; email?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body?.fleetId) throw new BadRequestException('Flotte requise');
    if (!body?.pairingCode) throw new BadRequestException('Code d\'appairage requis');
    if (!body?.email) throw new BadRequestException('Destinataire requis');
    return this.invitations.send({
      fleetId: body.fleetId,
      pairingCode: body.pairingCode,
      email: body.email,
      sentByUserId: req.user.id,
    });
  }

  /**
   * Le client n'a PAS de Maestroo : on lui crée son espace, puis on l'invite à
   * consentir. Pas de code à récupérer ailleurs — c'est tout l'intérêt.
   */
  @Post('provision')
  async provision(
    @Body() body: { fleetId?: string; email?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body?.fleetId) throw new BadRequestException('Flotte requise');
    if (!body?.email) throw new BadRequestException('Destinataire requis');
    return this.invitations.provisionAndInvite({
      fleetId: body.fleetId,
      email: body.email,
      sentByUserId: req.user.id,
    });
  }

  /** DRY-RUN — ce qui disparaîtrait. N'écrit RIEN, des deux côtés. */
  @Get(':id/revocation-preview')
  async preview(@Param('id') id: string) {
    return this.admin.revocationPreview(id);
  }

  /**
   * « Le client utilise-t-il Maestroo ? » — lu chez le partenaire à la demande
   * (étape 6, doc 25 §5). Injoignable ⇒ on l'AFFICHE (reachable:false), on ne
   * devine pas.
   */
  @Get(':id/activity')
  async activity(@Param('id') id: string) {
    try {
      const summary = await this.clientApi.fetchActivitySummary(id);
      return { reachable: true, ...summary };
    } catch {
      return { reachable: false };
    }
  }

  /** LEVIER IMPAYÉ — le client ne peut pas le lever lui-même. */
  @Post(':id/platform-suspend')
  async suspend(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    // La raison est AFFICHÉE au client : on l'exige plutôt que de le laisser
    // devant une coupure sans explication.
    if (!body?.reason?.trim()) throw new BadRequestException('Raison requise');
    const result = await this.admin.platformSuspend(id, body.reason.trim().slice(0, 200), req.user.id);
    if (result.changed) await this.outbox.dispatchNow(id);
    return result;
  }

  @Post(':id/platform-resume')
  async resume(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.admin.platformResume(id, req.user.id);
  }

  @Patch(':id/billing')
  async billing(
    @Param('id') id: string,
    @Body() body: { status?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    if (!body?.status || !BILLING_STATUSES.includes(body.status as BillingStatus)) {
      throw new BadRequestException(`Statut invalide (attendu : ${BILLING_STATUSES.join(', ')})`);
    }
    return this.admin.setBilling(id, body.status as BillingStatus, req.user.id);
  }
}
