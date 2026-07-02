import { Body, Controller, Get, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type {
  ApplyAgendaProposalDto,
  RunAgendaOptimizationDto,
  SetAgendaOptimizationScheduleDto,
} from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AgendaOptimizationService } from './agenda-optimization.service';

const ALL_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.FLEET_ADMIN,
  UserRole.FLEET_MANAGER,
  UserRole.VIEWER,
];

/**
 * Agenda AI — Vue « Optimisation & prévisions » (2 mois).
 *   - GET  /agenda/optimization/dashboard : timeline hebdo + opportunités + dernier rapport IA.
 *   - GET  /agenda/optimization/schedule  : config/planification de l'agent (par flotte).
 *   - PUT  /agenda/optimization/schedule  : régler enable / fréquence / autonomie (⚙️ Paramètres).
 * Scoping tenant strict délégué au service.
 */
@Controller('agenda/optimization')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class AgendaOptimizationController {
  constructor(private readonly svc: AgendaOptimizationService) {}

  @Get('dashboard')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  dashboard(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.svc.getDashboard(req.user, fleetId);
  }

  @Get('schedule')
  @Roles(...ALL_ROLES)
  @RequirePermissions('ai_optimize')
  getSchedule(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.svc.getSchedule(req.user, fleetId);
  }

  @Put('schedule')
  @Roles(...ALL_ROLES)
  @RequirePermissions('ai_optimize')
  setSchedule(@Req() req: AuthenticatedRequest, @Body() dto: SetAgendaOptimizationScheduleDto) {
    return this.svc.setSchedule(req.user, dto);
  }

  /** Scan IA complet à la demande (analyse l'agenda 2 mois → propositions). */
  @Post('run')
  @Roles(...ALL_ROLES)
  @RequirePermissions('ai_optimize')
  run(@Req() req: AuthenticatedRequest, @Body() dto: RunAgendaOptimizationDto) {
    return this.svc.runOnDemand(req.user, dto?.fleetId);
  }

  /** Historique des rapports d'optimisation IA (propositions). */
  @Get('reports')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  reports(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.svc.listReports(req.user, fleetId);
  }

  /** Applique une proposition (validation humaine). Perm reservations_manage (écrit une résa/event). */
  @Post('proposals/apply')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_manage')
  apply(@Req() req: AuthenticatedRequest, @Body() dto: ApplyAgendaProposalDto) {
    return this.svc.applyProposal(req.user, dto);
  }

  /** Rejette une proposition. */
  @Post('proposals/dismiss')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  dismiss(@Req() req: AuthenticatedRequest, @Body() dto: ApplyAgendaProposalDto) {
    return this.svc.dismissProposal(req.user, dto);
  }
}
