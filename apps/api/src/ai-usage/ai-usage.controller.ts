import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AiUsageService } from './ai-usage.service';
import { SetAiBudgetBodyDto } from './dto/set-ai-budget.dto';

/**
 * Palier « Coûts IA » — supervision des dépenses du copilote IA. La CONSULTATION (summary/logs)
 * est ouverte au FLEET_ADMIN, **scopée à sa propre société** (visibilité « qui consomme quoi »).
 * Le BUDGET (plafond global, transverse) reste SUPER_ADMIN uniquement.
 */
@Controller('admin/ai-usage')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AiUsageController {
  constructor(private readonly svc: AiUsageService) {}

  /**
   * Périmètre flotte appliqué à la consultation : un FLEET_ADMIN est FORCÉ à sa société
   * (jamais le fleetId du client) ; un SUPER_ADMIN filtre librement (undefined = toutes).
   */
  private scopeFleet(req: AuthenticatedRequest, requested?: string): string | undefined {
    return req.user.role === UserRole.SUPER_ADMIN ? (requested || undefined) : (req.user.fleetId ?? undefined);
  }

  /** GET /api/admin/ai-usage/summary — KPIs + répartitions (action/flotte/utilisateur/jour) + budget. */
  @Get('summary')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  summary(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
  ) {
    // Scope flotte (main : FLEET_ADMIN forcé à sa société) + viewer (owner : masque les owners).
    return this.svc.summary(from, to, this.scopeFleet(req, fleetId), req.user);
  }

  /** GET /api/admin/ai-usage/logs — journal des appels (curseur temporel `before` = ISO). */
  @Get('logs')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  logs(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('userId') userId?: string,
    @Query('fleetId') fleetId?: string,
    @Query('action') action?: string,
  ) {
    return this.svc.logs({
      limit: limit ? parseInt(limit, 10) : undefined,
      before,
      userId,
      fleetId: this.scopeFleet(req, fleetId),
      action,
    }, req.user);
  }

  /** GET /api/admin/ai-usage/budget — budget mensuel + dépense du mois + statut (global). */
  @Get('budget')
  @Roles(UserRole.SUPER_ADMIN)
  budget(@Req() req: AuthenticatedRequest) {
    // viewer : owner plateforme exclu de la dépense du mois pour un super-admin non-owner.
    return this.svc.getBudget(req.user);
  }

  /** PUT /api/admin/ai-usage/budget — règle le budget mensuel (€). */
  @Put('budget')
  @Roles(UserRole.SUPER_ADMIN)
  setBudget(@Body() dto: SetAiBudgetBodyDto, @Req() req: AuthenticatedRequest) {
    return this.svc.setBudget(dto.monthlyBudgetEur, req.user.id, req.user);
  }
}
