import { Body, Controller, Get, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type {
  BillingSettingsDto, BillingSetupIntentDto, BillingStatusDto, BillingSubscribeResultDto,
} from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BillingService, type BillingViewer } from './billing.service';
import { BillingSettingsService } from './billing-settings.service';
import { BillingFleetBodyDto, SetBillingPriceBodyDto, SetCompBodyDto } from './dto/billing-body.dto';

/**
 * Facturation de l'option IA. Consultation ouverte SUPER_ADMIN + FLEET_ADMIN (scopé à sa société) ;
 * les actions (carte, abonnement, facture, annulation) exigent `billing_manage`. Le prix configurable
 * et l'activation OFFERTE (COMP) sont réservés au SUPER_ADMIN (owner).
 */
@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly settings: BillingSettingsService,
  ) {}

  private viewer(req: AuthenticatedRequest): BillingViewer {
    return { id: req.user.id, role: req.user.role, fleetId: req.user.fleetId ?? null };
  }

  @Get('status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  status(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string): Promise<BillingStatusDto> {
    return this.billing.getStatus(this.viewer(req), fleetId);
  }

  @Post('setup-intent')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('billing_manage')
  setupIntent(@Req() req: AuthenticatedRequest, @Body() body: BillingFleetBodyDto): Promise<BillingSetupIntentDto> {
    return this.billing.createSetupIntent(this.viewer(req), body?.fleetId);
  }

  @Post('subscribe')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('billing_manage')
  subscribe(@Req() req: AuthenticatedRequest, @Body() body: BillingFleetBodyDto): Promise<BillingSubscribeResultDto> {
    return this.billing.subscribe(this.viewer(req), body?.fleetId);
  }

  @Post('request-invoice')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('billing_manage')
  requestInvoice(@Req() req: AuthenticatedRequest, @Body() body: BillingFleetBodyDto) {
    return this.billing.requestInvoice(this.viewer(req), body?.fleetId);
  }

  @Post('cancel')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('billing_manage')
  cancel(@Req() req: AuthenticatedRequest, @Body() body: BillingFleetBodyDto) {
    return this.billing.cancel(this.viewer(req), body?.fleetId);
  }

  /** OFFERT (COMP) — le super-admin/owner active/coupe l'IA d'une société sans paiement. */
  @Post('comp')
  @Roles(UserRole.SUPER_ADMIN)
  comp(@Req() req: AuthenticatedRequest, @Body() body: SetCompBodyDto) {
    return this.billing.setComp(this.viewer(req), body.fleetId, body.enabled);
  }

  /** Prix configurable de l'option IA (super-admin). */
  @Get('settings/price')
  @Roles(UserRole.SUPER_ADMIN)
  getPrice(): Promise<BillingSettingsDto> {
    return this.settings.toDto();
  }

  @Put('settings/price')
  @Roles(UserRole.SUPER_ADMIN)
  setPrice(@Req() req: AuthenticatedRequest, @Body() body: SetBillingPriceBodyDto): Promise<BillingSettingsDto> {
    return this.settings.setPrice(body.aiUnitAmountEurCents, body.aiPricingUnit, req.user.id);
  }
}
