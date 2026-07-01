import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AiUsageService } from './ai-usage.service';
import { SetAiBudgetBodyDto } from './dto/set-ai-budget.dto';

/**
 * Palier « Coûts IA » — supervision des dépenses du copilote IA. SUPER_ADMIN uniquement
 * (données transverses à toutes les flottes).
 */
@Controller('admin/ai-usage')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AiUsageController {
  constructor(private readonly svc: AiUsageService) {}

  /** GET /api/admin/ai-usage/summary — KPIs + répartitions (action/flotte/utilisateur/jour) + budget. */
  @Get('summary')
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.summary(from, to);
  }

  /** GET /api/admin/ai-usage/logs — journal des appels (curseur temporel `before` = ISO). */
  @Get('logs')
  logs(
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
      fleetId,
      action,
    });
  }

  /** GET /api/admin/ai-usage/budget — budget mensuel + dépense du mois + statut. */
  @Get('budget')
  budget() {
    return this.svc.getBudget();
  }

  /** PUT /api/admin/ai-usage/budget — règle le budget mensuel (€). */
  @Put('budget')
  setBudget(@Body() dto: SetAiBudgetBodyDto, @Req() req: AuthenticatedRequest) {
    return this.svc.setBudget(dto.monthlyBudgetEur, req.user.id);
  }
}
