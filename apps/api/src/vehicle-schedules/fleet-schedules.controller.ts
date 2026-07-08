import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import type { RequestedBy } from '../vehicles/vehicles.service';
import { BulkScheduleApplyDto } from './dto/bulk-schedule-apply.dto';
import { FleetSchedulesService } from './fleet-schedules.service';

/**
 * Demande CDEF (2026-07) — Page flotte « Horaires » (vue d'ensemble + actions de masse).
 *
 * Réservé aux détenteurs de la permission `schedules_manage` (fleet-admin par défaut ; le CDEF
 * peut l'accorder à qui il désigne, y compris un veilleur). SA/FA la bypassent (admins). Le
 * périmètre PAR VÉHICULE est re-résolu dans le service (`resolveTargets` / snapshot scopé) — le
 * guard global ici est une 1re barrière, pas la seule.
 *
 * NB sécurité : ce contrôleur est répertorié dans `night-watchman.security.spec.ts` (périmètre
 * IN) — un veilleur n'y accède QUE si `schedules_manage` lui a été accordé, scopé par véhicule.
 */
@Controller('fleet-schedules')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.NIGHT_WATCHMAN)
@RequirePermissions('schedules_manage')
export class FleetSchedulesController {
  constructor(
    private readonly fleet: FleetSchedulesService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  private async buildRequestedBy(req: AuthenticatedRequest): Promise<RequestedBy> {
    const accessibleVehicleIds = await this.vehicleAccess.getAccessibleVehicleIds(req.user);
    return { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds };
  }

  /** Vue d'ensemble : 1 ligne par véhicule (config planning + état live + compte-à-rebours). */
  @Get()
  async list(@Req() req: AuthenticatedRequest) {
    return this.fleet.listForFleet(await this.buildRequestedBy(req));
  }

  /** Aperçu d'un bulk AVANT application (combien seraient coupés maintenant, etc.) — aucune écriture. */
  @Post('bulk/preview')
  @HttpCode(200)
  async preview(@Req() req: AuthenticatedRequest, @Body() dto: BulkScheduleApplyDto) {
    return this.fleet.preview(req.user, dto);
  }

  /** Applique un bulk (activer/désactiver + poser des horaires) sur le périmètre autorisé. */
  @Post('bulk')
  @HttpCode(200)
  async bulk(@Req() req: AuthenticatedRequest, @Body() dto: BulkScheduleApplyDto) {
    return this.fleet.bulkApply(req.user, dto);
  }
}
