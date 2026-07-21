import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UpdatePricingGridDto, UpsertSubscriptionDto } from './dto/subscription-body.dto';
import { FleetSubscriptionsService } from './fleet-subscriptions.service';
import { PricingGridService } from './pricing-grid.service';

/**
 * D4 + Phase 3 — espace admin « Abonnements & tarifs » (SUPER_ADMIN uniquement) :
 * vue d'ensemble des abonnements clients (plan/formule/options/comp/revenu), modification,
 * et édition de la grille tarifaire publique (propagée à la LP sans redéploiement, ≤ 5 min).
 */
@Controller('admin/subscriptions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class SubscriptionsAdminController {
  constructor(
    private readonly subscriptions: FleetSubscriptionsService,
    private readonly pricing: PricingGridService,
  ) {}

  @Get()
  list() {
    return this.subscriptions.list();
  }

  @Put(':fleetId')
  upsert(
    @Param('fleetId', ParseUUIDPipe) fleetId: string,
    @Body() dto: UpsertSubscriptionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.subscriptions.upsert(fleetId, dto, { userId: req.user.id });
  }

  @Get('pricing/grid')
  grid() {
    return this.pricing.getWithMeta();
  }

  @Put('pricing/grid')
  async updateGrid(@Body() dto: UpdatePricingGridDto, @Req() req: AuthenticatedRequest) {
    const grid = await this.pricing.update(dto.grid, { userId: req.user.id });
    return { grid };
  }
}
