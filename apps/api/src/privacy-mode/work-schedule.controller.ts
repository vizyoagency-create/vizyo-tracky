import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireVehiclePermission } from '../auth/decorators/vehicle-permissions.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SetMixedUseDto } from './dto/set-mixed-use.dto';
import { SetWorkScheduleDto } from './dto/set-work-schedule.dto';
import { WorkScheduleService } from './work-schedule.service';

/**
 * Cadre de temps de travail par véhicule (usage mixte, RGPD). Sous-ressource de /vehicles
 * (`:vehicleId/work-schedule` plus profond que `GET /vehicles/:id`).
 *
 * - LECTURE : ouverte à tous les rôles (dont DRIVER) avec `vehicles_view` — le conducteur VOIT
 *   son cadre (transparence, ligne rouge (b)).
 * - ÉCRITURE : réservée au cadre (fleet-admin/gestionnaire) via `schedules_manage`. Le conducteur
 *   NE peut PAS éditer le cadre (il ne peut pas requalifier son temps de travail en privé).
 */
@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class WorkScheduleController {
  constructor(private readonly service: WorkScheduleService) {}

  @Get(':vehicleId/work-schedule')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER, UserRole.DRIVER)
  @RequireVehiclePermission('vehicles_view', { paramName: 'vehicleId' })
  get(@Param('vehicleId') vehicleId: string, @Req() req: AuthenticatedRequest) {
    return this.service.get(vehicleId, { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId });
  }

  @Put(':vehicleId/work-schedule')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequireVehiclePermission('schedules_manage', { paramName: 'vehicleId' })
  set(@Param('vehicleId') vehicleId: string, @Body() dto: SetWorkScheduleDto, @Req() req: AuthenticatedRequest) {
    return this.service.set(vehicleId, dto, { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId });
  }

  /**
   * Déclare/retire l'USAGE MIXTE d'un véhicule (interrupteur de proportionnalité CNIL). Même
   * périmètre que le cadre : c'est l'employeur qui déclare qu'un véhicule est ramené au domicile.
   * Le conducteur ne peut PAS s'auto-déclarer en usage mixte.
   */
  @Put(':vehicleId/mixed-use')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequireVehiclePermission('schedules_manage', { paramName: 'vehicleId' })
  setMixedUse(@Param('vehicleId') vehicleId: string, @Body() dto: SetMixedUseDto, @Req() req: AuthenticatedRequest) {
    return this.service.setMixedUse(vehicleId, dto.enabled, { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId });
  }
}
