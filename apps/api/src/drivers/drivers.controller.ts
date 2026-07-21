import {
  Body,
  Controller,
  Delete,
  Get,
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
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AnonymizeDriverDto } from './dto/anonymize-driver.dto';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { DriversService } from './drivers.service';
import { WorkTimeService } from './work-time.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly workTime: WorkTimeService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /** GET /drivers — liste fleet-scoped, ?includeArchived=true pour les archives. */
  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('drivers_view')
  list(
    @Req() req: AuthenticatedRequest,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.drivers.list(this.rb(req), includeArchived === 'true');
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('drivers_view')
  findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.drivers.findOne(id, this.rb(req));
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('drivers_manage')
  create(@Body() dto: CreateDriverDto, @Req() req: AuthenticatedRequest) {
    return this.drivers.create(dto, this.rb(req));
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('drivers_manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDriverDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.drivers.update(id, dto, this.rb(req));
  }

  /** Soft-delete : isActive=false + retire le driver des Vehicle.currentDriverId. */
  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('drivers_manage')
  archive(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.drivers.archive(id, this.rb(req));
  }

  /** RGPD art. 15 — export JSON complet des données du conducteur (téléchargement, audité). */
  @Get(':id/gdpr-export')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('drivers_manage')
  async gdprExport(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    const data = await this.drivers.gdprExport(id, this.rb(req));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rgpd-conducteur-${id}.json"`);
    res.send(JSON.stringify(data, null, 2));
  }

  /**
   * RGPD 4.5 — registre du temps de travail (CSV) : jours travaillés, amplitude et conduite pure,
   * SANS aucune position. Rétention propre 5 ans. Export audité (catégorie EXPORT).
   */
  @Get(':id/work-time.csv')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('drivers_manage')
  async workTimeCsv(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const driver = await this.drivers.findOne(id, this.rb(req)); // 404 cross-flotte
    const csv = await this.workTime.exportCsv(driver.id, driver.fleetId, from, to);
    this.systemActivity.record({
      category: 'EXPORT',
      action: 'work_time_export',
      status: 'SUCCESS',
      actor: 'opérateur',
      target: `${driver.firstName} ${driver.lastName}`.trim(),
      detail: `Export du registre de temps de travail (CSV${from || to ? `, ${from ?? '…'} → ${to ?? '…'}` : ''})`,
      fleetId: driver.fleetId,
      triggeredByUserId: req.user.id,
      meta: { driverId: driver.id, from: from ?? null, to: to ?? null },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="temps-travail-${id}.csv"`);
    res.send('﻿' + csv);
  }

  /** RGPD art. 17 — anonymisation IRRÉVERSIBLE (PII effacée, compte désactivé). Confirmation exigée. */
  @Post(':id/anonymize')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('drivers_manage')
  anonymize(@Param('id') id: string, @Body() dto: AnonymizeDriverDto, @Req() req: AuthenticatedRequest) {
    void dto; // la validation (@Equals(true)) fait office de garde-fou anti-clic accidentel
    return this.drivers.anonymize(id, this.rb(req));
  }

  private rb(req: AuthenticatedRequest) {
    return { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId };
  }
}
