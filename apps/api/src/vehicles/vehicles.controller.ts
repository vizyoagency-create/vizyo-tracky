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
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireVehiclePermission } from '../auth/decorators/vehicle-permissions.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AssignDriverDto } from '../drivers/dto/assign-driver.dto';
import { DriversService } from '../drivers/drivers.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { SetVehicleGroupDto } from './dto/set-vehicle-group.dto';
import { SyncFromInstallationDto } from './dto/sync-from-installation.dto';
import { SetOutOfServiceDto } from './dto/set-out-of-service.dto';
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
    private readonly systemActivity: SystemActivityService,
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
  // C3 (incident CDEF31 du 24/09/2026) — limite RELEVÉE, pas supprimée.
  //
  // Cet endpoint n'est pas une lecture comme une autre : c'est le SEUL chemin par lequel un client
  // répare un état d'affichage faux (positions + état coupe tri-état). La nuit du 23 au 24/09, la
  // limite globale (100 req/min) l'a renvoyé **6 fois en 429** au veilleur de CDEF31 — pendant
  // qu'il cliquait en boucle sur un bouton dont l'état était justement faux. La protection a donc
  // verrouillé la porte de secours au moment précis où elle servait.
  //
  // 300/min laisse largement passer une page qui se recale (un snapshot par reconnexion + le poll
  // de 15 s) tout en gardant une borne : la réponse est cachée 15 s côté service pour le scope
  // 'ALL', donc un client qui s'emballe ne martèle pas la base. Supprimer la borne
  // (`@SkipThrottle`) exposerait une requête à 2 000 véhicules sans aucun plafond.
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  async snapshot(@Req() req: AuthenticatedRequest) {
    const items = await this.vehicles.snapshot(await this.buildRequestedBy(req));
    return { items };
  }

  // Sprint 10 — Vue « Parc & capacités » : déclarée AVANT @Get(':id') (sinon 'capacity-overview'
  // serait capturé comme un :id). Lecture scopée tenant + accès granulaire (vehicles_view).
  //
  // Revue du 29/09 — `fleetId` = société choisie dans le bandeau (super-admin), comme pour
  // `/vehicles/stats`. Sans lui, un super-admin recevait les 500 premières plaques de TOUTES les
  // sociétés, et la vue Parc de l'agenda devait les recouper avec `GET /vehicles` (plafonné à
  // 50) : les véhicules anciens d'une société disparaissaient de sa grille. Ignoré pour un
  // non-super : le service impose toujours SA flotte, donc aucun passage d'une société à l'autre.
  @Get('capacity-overview')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('vehicles_view')
  async capacityOverview(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.vehicles.capacityOverview(await this.buildRequestedBy(req), fleetId || null);
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
    // Traçabilité — émission des « clés » QR de toute une flotte (action sensible → feed admin).
    // Fire-and-forget (ne bloque pas la génération). On ne journalise JAMAIS de jeton.
    this.systemActivity.record({
      category: 'ENGINE',
      action: 'unlock_qr_sheet_printed',
      status: 'SUCCESS',
      actor: 'opérateur',
      target: 'Feuille QR de déverrouillage (flotte)',
      detail: 'Génération de la feuille imprimable des QR de déverrouillage',
      fleetId: req.user.fleetId ?? fleetId ?? null,
      triggeredByUserId: req.user.id,
      meta: { scope: fleetId ?? 'own' },
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  // feat/comptes-conducteurs — Données JSON des QR de déverrouillage (plaque/modèle/lien signé) pour le
  // rendu PREMIUM client-side de la feuille imprimable. Segment STATIQUE → AVANT @Get(':id'). Gate qr_manage.
  @Get('unlock-qr-links')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('qr_manage')
  async unlockQrLinks(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    const result = await this.vehicles.buildUnlockQrLinks(await this.buildRequestedBy(req), fleetId || null);
    // Traçabilité — émission de la feuille de « clés » QR (action sensible → feed admin). Sans jeton.
    this.systemActivity.record({
      category: 'ENGINE',
      action: 'unlock_qr_sheet_printed',
      status: 'SUCCESS',
      actor: 'opérateur',
      target: 'Feuille QR de déverrouillage (flotte)',
      detail: `Génération de la feuille imprimable premium (${result.items.length} QR)`,
      fleetId: req.user.fleetId ?? fleetId ?? null,
      triggeredByUserId: req.user.id,
      meta: { count: result.items.length, scope: fleetId ?? 'own' },
    });
    return result;
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
    const qr = await this.vehicles.buildUnlockQr(id, await this.buildRequestedBy(req));
    // Traçabilité — émission de la « clé » QR d'un véhicule (action sensible → feed admin).
    // Fire-and-forget ; le jeton n'est JAMAIS journalisé.
    this.systemActivity.record({
      category: 'ENGINE',
      action: 'unlock_qr_generated',
      status: 'SUCCESS',
      actor: 'opérateur',
      target: qr.plate,
      detail: 'Génération du QR de déverrouillage du véhicule',
      fleetId: req.user.fleetId ?? null,
      triggeredByUserId: req.user.id,
      meta: { vehicleId: qr.vehicleId },
    });
    return qr;
  }

  /**
   * Cas SPECIAUX : vehicule accidente, boitier debranche, immobilisation longue.
   * `reason: null` remet en service. SUPER_ADMIN uniquement — cet etat fait TAIRE des
   * traitements et des alertes, il ne doit pas etre a portee d'un gestionnaire de flotte.
   */
  @Patch(':id/out-of-service')
  @Roles(UserRole.SUPER_ADMIN)
  async setOutOfService(
    @Param('id') id: string,
    @Body() dto: SetOutOfServiceDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.vehicles.setOutOfService(id, dto, await this.buildRequestedBy(req));
  }

  /**
   * Revue du 29/09 (T9) — écrire UN véhicule exige le droit SUR CE véhicule, pas l'union des droits.
   *
   * `@RequirePermissions('vehicles_edit')` seul résout l'union des scopes : un gestionnaire qui a
   * `vehicles_edit` sur le groupe Nord et seulement `vehicles_view` sur le groupe Sud passait la
   * garde pour un véhicule Sud — la vue Parc de l'agenda et l'onglet Capacités lui offraient la
   * feuille de réglage, et places, énergie, équipements étaient réécrits. Et comme le service ne
   * recevait pas `accessibleVehicleIds`, `findOne` ne filtrait que la société : un compte limité à
   * Nord modifiait, par son UUID, n'importe quel véhicule de sa société.
   *
   * Deux verrous, donc : la garde résout `vehicles_edit` sur la ligne d'accès qui couvre CE véhicule
   * (403 si elle le refuse ou si aucune ne le couvre ; super-admin et admin de flotte passent), et
   * `buildRequestedBy` fait appliquer le périmètre par `findOne` (404 hors périmètre). Même règle
   * pour la synchro depuis le planning et la suppression ci-dessous.
   */
  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_edit')
  @RequireVehiclePermission('vehicles_edit', { paramName: 'id' })
  async update(@Param('id') id: string, @Body() dto: UpdateVehicleDto, @Req() req: AuthenticatedRequest) {
    return this.vehicles.update(id, dto, await this.buildRequestedBy(req));
  }

  /** Sprint 10 — Source de synchro (planning d'installation lié) pour pré-remplir/comparer. Lecture scopée. */
  @Get(':id/installation-source')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('vehicles_view')
  async installationSource(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.vehicles.getInstallationSource(id, await this.buildRequestedBy(req));
  }

  /**
   * Sprint 10 — Recopie les champs choisis (marque/modèle/énergie) du planning vers le véhicule.
   * Revue du 29/09 (T9) : c'est une écriture du véhicule — même double verrou que `PATCH :id`.
   */
  @Post(':id/sync-from-installation')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_edit')
  @RequireVehiclePermission('vehicles_edit', { paramName: 'id' })
  async syncFromInstallation(
    @Param('id') id: string,
    @Body() dto: SyncFromInstallationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.vehicles.syncFromInstallation(id, dto.fields, await this.buildRequestedBy(req));
  }

  /** Revue du 29/09 (T9) : même trou que `PATCH :id` — `vehicles_delete` résolu sur CE véhicule, périmètre appliqué. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('vehicles_delete')
  @RequireVehiclePermission('vehicles_delete', { paramName: 'id' })
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.vehicles.remove(id, await this.buildRequestedBy(req));
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
