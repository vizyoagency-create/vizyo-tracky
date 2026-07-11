import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AssignDriverDto } from '../drivers/dto/assign-driver.dto';
import { DriversService } from '../drivers/drivers.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { SetVehicleGroupDto } from './dto/set-vehicle-group.dto';
import { SyncFromInstallationDto } from './dto/sync-from-installation.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import type { RequestedBy } from './vehicles.service';
import { VehiclesService } from './vehicles.service';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class VehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly drivers: DriversService,
  ) {}

  private async buildRequestedBy(req: AuthenticatedRequest): Promise<RequestedBy> {
    const accessibleVehicleIds = await this.vehicleAccess.getAccessibleVehicleIds(req.user);
    return { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds };
  }

  @Get('stats')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  async stats(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    // `fleetId` = filtre société global (sélecteur super-admin). Ignoré pour un non-super
    // (déjà borné à sa flotte). Anti-IDOR : le super-admin a accès à toutes les flottes.
    return this.vehicles.stats(await this.buildRequestedBy(req), fleetId || null);
  }

  @Get('snapshot')
  // Sprint 3 — veilleur inclus : résultats scopés par accessibleVehicleIds dans le service.
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER, UserRole.NIGHT_WATCHMAN)
  async snapshot(@Req() req: AuthenticatedRequest) {
    const items = await this.vehicles.snapshot(await this.buildRequestedBy(req));
    return { items };
  }

  // Sprint 10 — Vue « Parc & capacités » : déclarée AVANT @Get(':id') (sinon 'capacity-overview'
  // serait capturé comme un :id). Lecture scopée tenant + accès granulaire (vehicles_view).
  @Get('capacity-overview')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('vehicles_view')
  async capacityOverview(@Req() req: AuthenticatedRequest) {
    return this.vehicles.capacityOverview(await this.buildRequestedBy(req));
  }

  // feat/comptes-conducteurs (4a) — Feuille HTML imprimable de TOUS les QR de déverrouillage
  // (fleet-scopée). Segment STATIQUE → déclarée AVANT @Get(':id'). `fleetId` = sélecteur société
  // (super-admin). Gate `qr_manage` (super/fleet-admin bypass natif ; accordable aux autres).
  @Get('unlock-qr-sheet')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('qr_manage')
  async unlockQrSheet(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('fleetId') fleetId?: string,
  ): Promise<void> {
    const html = await this.vehicles.buildUnlockQrSheet(await this.buildRequestedBy(req), fleetId || null);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  @Post()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_create')
  create(@Body() dto: CreateVehicleDto, @Req() req: AuthenticatedRequest) {
    return this.vehicles.create(dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Get()
  // DRIVER inclus (feat/comptes-conducteurs incr.6 : écran « Mes véhicules »). Résultats scopés
  // au périmètre du conducteur (accessibleVehicleIds) + permission vehicles_view par véhicule.
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER, UserRole.NIGHT_WATCHMAN, UserRole.DRIVER)
  @RequirePermissions('vehicles_view')
  async findAll(
    @Req() req: AuthenticatedRequest,
    @Query('search') search?: string,
    @Query('hasTracker') hasTracker?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const requestedBy = await this.buildRequestedBy(req);
    return this.vehicles.findAll(requestedBy, { search, hasTracker, limit: limit ? parseInt(limit, 10) : undefined, cursor });
  }

  @Get(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER, UserRole.NIGHT_WATCHMAN)
  @RequirePermissions('vehicles_view')
  async findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.vehicles.findOne(id, await this.buildRequestedBy(req));
  }

  // feat/comptes-conducteurs (4a) — QR de déverrouillage d'un véhicule : { vehicleId, plate, token, url, svg }.
  @Get(':id/unlock-qr')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('qr_manage')
  async unlockQr(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.vehicles.buildUnlockQr(id, await this.buildRequestedBy(req));
  }

  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_edit')
  update(@Param('id') id: string, @Body() dto: UpdateVehicleDto, @Req() req: AuthenticatedRequest) {
    return this.vehicles.update(id, dto, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  /** Sprint 10 — Source de synchro (planning d'installation lié) pour pré-remplir/comparer. Lecture scopée. */
  @Get(':id/installation-source')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('vehicles_view')
  async installationSource(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.vehicles.getInstallationSource(id, await this.buildRequestedBy(req));
  }

  /** Sprint 10 — Recopie les champs choisis (marque/modèle/énergie) du planning vers le véhicule. */
  @Post(':id/sync-from-installation')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_edit')
  syncFromInstallation(
    @Param('id') id: string,
    @Body() dto: SyncFromInstallationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.vehicles.syncFromInstallation(id, dto.fields, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_delete')
  remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.vehicles.remove(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }

  /**
   * Phase 2 — Definit/retire le conducteur "courant" du vehicule.
   * Snape sur Trip.driverId au prochain finalize (driverSource='AUTO').
   */
  @Patch(':id/driver')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('drivers_manage')
  assignDriver(
    @Param('id') id: string,
    @Body() dto: AssignDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.drivers.assignToVehicle(id, dto.driverId, {
      userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId,
    });
  }

  /**
   * Sprint 1 (Fondation Groupes) — définit/retire le groupe (single) du véhicule.
   * body `{ groupId: <uuid> }` pour assigner, `{ groupId: null }` pour retirer.
   * Même autorité que l'admin groupes (FLEET_ADMIN/SUPER_ADMIN) ; le scoping
   * tenant + la vérif même-flotte sont dans VehiclesService.setGroup.
   */
  @Patch(':id/group')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async setGroup(
    @Param('id') id: string,
    @Body() dto: SetVehicleGroupDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.vehicles.setGroup(id, dto.groupId, await this.buildRequestedBy(req));
  }
}
