import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FleetInsightsService } from './fleet-insights.service';

const ALL_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.FLEET_ADMIN,
  UserRole.FLEET_MANAGER,
  UserRole.VIEWER,
  UserRole.NIGHT_WATCHMAN,
];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_DAYS = 366;
const DEFAULT_UTILIZATION_DAYS = 28;

function parseDate(raw: string | undefined, field: string): Date {
  if (!raw) throw new BadRequestException(`${field} (ISO) requis`);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} invalide`);
  return d;
}

function assertWindow(from: Date, to: Date): void {
  if (to.getTime() <= from.getTime()) throw new BadRequestException('Fenêtre invalide (to <= from)');
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new BadRequestException(`Fenêtre trop large (max ${MAX_WINDOW_DAYS} jours)`);
  }
}

/**
 * Sprint 8 (Palier A) — Visibilité flotte (lecture seule), gardée par `reservations_view`.
 *   - GET /agenda/availability : activité réelle (trajets) pour la couche agenda.
 *   - GET /optimization/utilization : heatmap d'utilisation + sous-utilisation (dashboard).
 * Scoping tenant strict délégué au service.
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class FleetInsightsController {
  constructor(private readonly insights: FleetInsightsService) {}

  @Get('agenda/availability')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  availability(
    @Req() req: AuthenticatedRequest,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('vehicleId') vehicleId?: string,
    @Query('groupId') groupId?: string,
  ) {
    const f = parseDate(from, 'from');
    const t = parseDate(to, 'to');
    assertWindow(f, t);
    return this.insights.getAvailability(req.user, f, t, { vehicleId, groupId });
  }

  @Get('optimization/utilization')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  utilization(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('vehicleId') vehicleId?: string,
    @Query('groupId') groupId?: string,
  ) {
    const t = to ? parseDate(to, 'to') : new Date();
    const f = from ? parseDate(from, 'from') : new Date(t.getTime() - DEFAULT_UTILIZATION_DAYS * DAY_MS);
    assertWindow(f, t);
    return this.insights.getUtilization(req.user, f, t, { vehicleId, groupId });
  }
}
