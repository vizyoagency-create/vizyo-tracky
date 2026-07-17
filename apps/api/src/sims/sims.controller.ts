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
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AssignSimDto } from './dto/assign-sim.dto';
import { BulkCreateSimDto } from './dto/bulk-create-sim.dto';
import { CreateSimDto } from './dto/create-sim.dto';
import { SendSimSmsDto } from './dto/send-sms.dto';
import { SetSimDataLimitDto } from './dto/set-data-limit.dto';
import { SetSimStatusDto } from './dto/set-status.dto';
import { UpdateSimDto } from './dto/update-sim.dto';
import { SimsService } from './sims.service';

/** Parc SIM RÉSERVÉ au SUPER_ADMIN (opérateur) : l'abonnement client inclut la SIM,
 *  la gestion se fait donc uniquement côté opérateur. Aucun accès pour les rôles
 *  client (FLEET_ADMIN / FLEET_MANAGER / VIEWER) — page retirée de l'app client. */
const SIM_OPERATOR = [UserRole.SUPER_ADMIN] as const;

/**
 * V1.16 — Parc SIM WhereverSIM.
 *
 * Lecture / conso / events : sims_view (sc0pe flotte). Assignation tracker :
 * sims_assign. Gestion (sync, allocation, cycle de vie, SMS, create/delete) :
 * SUPER_ADMIN. Les routes statiques sont declarees AVANT `:id`.
 */
@Controller('sims')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class SimsController {
  constructor(private readonly sims: SimsService) {}

  @Get()
  @Roles(...SIM_OPERATOR)
  @RequirePermissions('sims_view')
  list(
    @Req() req: AuthenticatedRequest,
    @Query('q') q?: string,
    @Query('unassigned') unassigned?: string,
    @Query('fleetId') fleetId?: string,
  ) {
    return this.sims.list(this.rb(req), { q, unassigned, fleetId });
  }

  @Get('assignable-trackers')
  @Roles(...SIM_OPERATOR)
  @RequirePermissions('sims_view')
  assignableTrackers(@Req() req: AuthenticatedRequest) {
    return this.sims.assignableTrackers(this.rb(req));
  }

  @Get('stats')
  @Roles(UserRole.SUPER_ADMIN)
  stats() {
    return this.sims.stats();
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN)
  sync() {
    return this.sims.syncAll();
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN)
  create(@Body() dto: CreateSimDto) {
    return this.sims.create(dto);
  }

  @Post('bulk')
  @Roles(UserRole.SUPER_ADMIN)
  bulk(@Body() dto: BulkCreateSimDto) {
    return this.sims.bulkCreate(dto.raw);
  }

  @Get(':id')
  @Roles(...SIM_OPERATOR)
  @RequirePermissions('sims_view')
  findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.sims.findOne(id, this.rb(req));
  }

  @Get(':id/consumption')
  @Roles(...SIM_OPERATOR)
  @RequirePermissions('sims_view')
  consumption(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.sims.consumption(id, this.rb(req), from, to);
  }

  @Get(':id/events')
  @Roles(...SIM_OPERATOR)
  @RequirePermissions('sims_view')
  events(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
    @Query('nextToken') nextToken?: string,
  ) {
    return this.sims.events(id, this.rb(req), nextToken);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @Roles(...SIM_OPERATOR)
  @RequirePermissions('sims_assign')
  assign(
    @Param('id') id: string,
    @Body() dto: AssignSimDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sims.assign(id, dto.trackerId, this.rb(req));
  }

  @Post(':id/unassign')
  @HttpCode(HttpStatus.OK)
  @Roles(...SIM_OPERATOR)
  @RequirePermissions('sims_assign')
  unassign(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.sims.unassign(id, this.rb(req));
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateSimDto) {
    return this.sims.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.SUPER_ADMIN)
  remove(@Param('id') id: string) {
    return this.sims.remove(id);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN)
  setStatus(@Param('id') id: string, @Body() dto: SetSimStatusDto) {
    return this.sims.setStatus(id, dto.statusId);
  }

  @Post(':id/data-limit')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN)
  setDataLimit(@Param('id') id: string, @Body() dto: SetSimDataLimitDto) {
    return this.sims.setDataLimit(id, dto.bytes);
  }

  @Post(':id/sms')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN)
  sendSms(@Param('id') id: string, @Body() dto: SendSimSmsDto) {
    return this.sims.sendSms(id, dto.text);
  }

  private rb(req: AuthenticatedRequest) {
    return { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId };
  }
}
