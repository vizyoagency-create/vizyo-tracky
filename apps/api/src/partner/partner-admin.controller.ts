import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BILLING_STATUSES, PartnerAdminService, type BillingStatus } from './partner-admin.service';
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
  ) {}

  @Get()
  async list() {
    return this.admin.list();
  }

  /** DRY-RUN — ce qui disparaîtrait. N'écrit RIEN, des deux côtés. */
  @Get(':id/revocation-preview')
  async preview(@Param('id') id: string) {
    return this.admin.revocationPreview(id);
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
