import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AgendaAgentRunnerService } from './agenda-agent-runner.service';

const ALL_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.FLEET_ADMIN,
  UserRole.FLEET_MANAGER,
  UserRole.VIEWER,
  UserRole.NIGHT_WATCHMAN,
];

/**
 * Refonte agenda/IA (2026-07, P3) — Agent nocturne : lancement à la demande + revue des propositions.
 * Lancer l'agent = SUPER_ADMIN/FLEET_ADMIN (opérateur de l'agent) ET reservations_manage : un
 * passage manuel peut CRÉER des réservations fermes (autonomie auto), c'est le même geste que
 * valider une proposition. Voir les propositions = reservations_view ; valider/refuser =
 * reservations_manage (mêmes gardes que les réservations).
 */
@Controller('agenda/agent')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class AgendaAgentController {
  constructor(private readonly runner: AgendaAgentRunnerService) {}

  /**
   * Lance l'analyse maintenant (propositions ; réserve ferme si autonomie auto + confiance ≥ seuil).
   * Répond 409 (`AutomationDisabledException`) si l'agent est désactivé pour la société : le
   * bouton ne contourne plus l'interrupteur (design/C3 point 2). La permission est celle de ses
   * voisines `apply` / `dismiss` — la route était la seule du contrôleur à n'en exiger aucune.
   */
  @Post('run')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('reservations_manage')
  run(@Req() req: AuthenticatedRequest, @Body() body?: { fleetId?: string }) {
    return this.runner.runOnDemand(req.user, body?.fleetId);
  }

  /**
   * Historique des passages de l'agent : ce qu'il a fait, combien de récurrences il a vues, s'il
   * a utilisé l'IA, et ce qui a échoué. Même droit de lecture que les propositions.
   */
  @Get('runs')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  runs(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetId?: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? Number(limit) : undefined;
    return this.runner.listRuns(req.user, fleetId, Number.isFinite(n) ? n : undefined);
  }

  /** Liste des propositions de l'agent (défaut : en attente). */
  @Get('proposals')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  list(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetId?: string,
    @Query('status') status?: string,
  ) {
    return this.runner.list(req.user, fleetId, status ?? 'pending');
  }

  /** Valide une proposition -> crée la réservation ferme. */
  @Post('proposals/:id/apply')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_manage')
  apply(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.runner.apply(req.user, id);
  }

  /** Refuse une proposition. */
  @Post('proposals/:id/dismiss')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_manage')
  dismiss(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.runner.dismiss(req.user, id);
  }
}
