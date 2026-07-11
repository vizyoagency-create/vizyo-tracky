import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireVehiclePermission } from '../auth/decorators/vehicle-permissions.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SetPrivacyModeDto } from './dto/set-privacy-mode.dto';
import { PrivacyModeService } from './privacy-mode.service';

/**
 * Mode vie privée conducteur (par véhicule). Protégé par la permission
 * `privacy_manage` résolue per-vehicle (règle « spécifique gagne »). Ouvert aux rôles
 * non-veilleur, y compris DRIVER (feat/comptes-conducteurs incr.5 : le conducteur peut
 * mettre SON véhicule en vie privée si le fleet-admin lui a accordé `privacy_manage`) ;
 * le guard filtre selon la permission (admins bypass).
 *
 * Sous-ressource de /vehicles (pas de collision : `:vehicleId/privacy-mode` est plus
 * profond que `GET /vehicles/:id`).
 */
@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class PrivacyModeController {
  constructor(private readonly service: PrivacyModeService) {}

  @Get(':vehicleId/privacy-mode')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER, UserRole.DRIVER)
  @RequireVehiclePermission('vehicles_view', { paramName: 'vehicleId' })
  getState(@Param('vehicleId') vehicleId: string) {
    return this.service.getState(vehicleId);
  }

  @Get(':vehicleId/privacy-mode/history')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER, UserRole.DRIVER)
  @RequireVehiclePermission('vehicles_view', { paramName: 'vehicleId' })
  getHistory(@Param('vehicleId') vehicleId: string, @Query('limit') limit?: string) {
    return this.service.getHistory(vehicleId, limit ? parseInt(limit, 10) || 30 : 30);
  }

  @Post(':vehicleId/privacy-mode')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER, UserRole.DRIVER)
  @RequireVehiclePermission('privacy_manage', { paramName: 'vehicleId' })
  set(@Param('vehicleId') vehicleId: string, @Body() dto: SetPrivacyModeDto, @Req() req: AuthenticatedRequest) {
    return this.service.setPrivacyMode(vehicleId, { enabled: dto.enabled, reason: dto.reason ?? null }, { userId: req.user.id });
  }
}
