import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { RetentionStatsService } from './retention-stats.service';

/**
 * Sprint 6 — Vues de suivi de la retention des positions (LECTURE SEULE + refresh).
 *
 * AUCUN endpoint ne supprime quoi que ce soit : la suppression reelle est pilotee par le
 * cron (DataRetentionService) derriere POSITIONS_PURGE_ENABLED. Ici on ne fait qu'EXPOSER
 * l'etat (compteurs actif / archive-preavis / a-supprimer + echeances) et, pour le
 * super-admin, recalculer le snapshot a la demande.
 */
@Controller('retention')
@UseGuards(JwtAuthGuard)
export class RetentionController {
  constructor(private readonly stats: RetentionStatsService) {}

  /** GET /retention/overview — etat global + par flotte + config. SUPER_ADMIN. */
  @Get('overview')
  @Roles(UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard)
  getOverview() {
    return this.stats.getOverview();
  }

  /** GET /retention/fleet — etat de SA flotte + config. FLEET_ADMIN (ou SUPER_ADMIN). */
  @Get('fleet')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard)
  getFleet(@Req() req: AuthenticatedRequest) {
    return this.stats.getFleetView(req.user.fleetId);
  }

  /** POST /retention/refresh — recalcule le snapshot (lecture seule, n'efface RIEN). SUPER_ADMIN. */
  @Post('refresh')
  @Roles(UserRole.SUPER_ADMIN)
  @UseGuards(RolesGuard)
  refresh() {
    return this.stats.refresh();
  }
}
