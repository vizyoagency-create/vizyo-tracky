import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { WorkScheduleService } from './work-schedule.service';

/**
 * Lot 2 — COUVERTURE vie privée de la flotte : quels véhicules sont réellement protégés hors
 * temps de travail, et lesquels ne le sont pas. L'absence de protection doit être VISIBLE.
 *
 * Chemin dédié (`/privacy-coverage`) pour ne pas entrer en collision avec `GET /vehicles/:id`.
 * Gate : permission EXISTANTE `privacy_manage` (super/fleet-admin la portent nativement ; un
 * fleet-admin peut l'accorder à un gestionnaire ou un lecteur depuis la matrice d'accès).
 */
@Controller('privacy-coverage')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class PrivacyCoverageController {
  constructor(private readonly service: WorkScheduleService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('privacy_manage')
  coverage(@Req() req: AuthenticatedRequest) {
    return this.service.coverage({ userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId });
  }
}
