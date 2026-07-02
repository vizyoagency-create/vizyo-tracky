import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole, VehicleEventStatus, VehicleEventType } from '@prisma/client';
import type {
  CreateVehicleEventDto,
  RecordMaintenanceDoneDto,
  ReportIncidentDto,
  UpdateVehicleEventDto,
  UpsertMaintenancePlanDto,
} from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { MaintenancePlansService } from './maintenance-plans.service';
import { VehicleEventsService } from './vehicle-events.service';

// Tous les rôles passent le filtre de rôle ; la VRAIE barrière est la permission
// (agenda_view / agenda_manage), OFF par défaut sauf SUPER_ADMIN/FLEET_ADMIN, accordable par user.
const ALL_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.FLEET_ADMIN,
  UserRole.FLEET_MANAGER,
  UserRole.VIEWER,
  UserRole.NIGHT_WATCHMAN,
];

function parseRequired(raw: string | undefined, field: string): Date {
  if (!raw) throw new BadRequestException(`${field} (ISO) requis`);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} invalide`);
  return d;
}

/**
 * Sprint 7 — Agenda générique (maintenance + incidents). Lecture/signalement = `agenda_view` ;
 * gestion (maintenance, plans, statuts) = `agenda_manage`. Scoping tenant strict dans les services.
 */
@Controller('agenda')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class AgendaController {
  constructor(
    private readonly events: VehicleEventsService,
    private readonly plans: MaintenancePlansService,
  ) {}

  // ─── Événements (calendrier) ───

  @Get('events')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_view')
  listEvents(
    @Req() req: AuthenticatedRequest,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('vehicleId') vehicleId?: string,
    @Query('groupId') groupId?: string,
    @Query('type') type?: VehicleEventType,
    @Query('status') status?: VehicleEventStatus,
    @Query('fleetId') fleetId?: string,
  ) {
    return this.events.list(req.user, {
      from: parseRequired(from, 'from'),
      to: parseRequired(to, 'to'),
      vehicleId,
      groupId,
      type,
      status,
      fleetId,
    });
  }

  @Get('summary')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_view')
  summary(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.events.summary(req.user, fleetId);
  }

  @Get('vehicles/:vehicleId/odometer')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_view')
  odometer(@Req() req: AuthenticatedRequest, @Param('vehicleId', ParseUUIDPipe) vehicleId: string) {
    return this.events.estimateOdometer(req.user, vehicleId);
  }

  /** Signaler un incident — accessible à `agenda_view` (accordé explicitement par un admin). */
  @Post('incidents')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_view')
  reportIncident(@Req() req: AuthenticatedRequest, @Body() dto: ReportIncidentDto) {
    return this.events.reportIncident(req.user, dto);
  }

  @Post('events')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_manage')
  createEvent(@Req() req: AuthenticatedRequest, @Body() dto: CreateVehicleEventDto) {
    return this.events.create(req.user, dto);
  }

  @Patch('events/:id')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_manage')
  updateEvent(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleEventDto,
  ) {
    return this.events.update(req.user, id, dto);
  }

  @Delete('events/:id')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_manage')
  deleteEvent(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.events.remove(req.user, id);
  }

  // ─── Plans de maintenance ───

  @Get('plans')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_view')
  listPlans(@Req() req: AuthenticatedRequest, @Query('vehicleId') vehicleId?: string) {
    return this.plans.list(req.user, vehicleId);
  }

  @Post('plans')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_manage')
  createPlan(@Req() req: AuthenticatedRequest, @Body() dto: UpsertMaintenancePlanDto) {
    return this.plans.upsert(req.user, null, dto);
  }

  @Put('plans/:id')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_manage')
  updatePlan(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertMaintenancePlanDto,
  ) {
    return this.plans.upsert(req.user, id, dto);
  }

  @Post('plans/:id/done')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_manage')
  recordDone(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecordMaintenanceDoneDto,
  ) {
    return this.plans.recordDone(req.user, id, body);
  }

  @Delete('plans/:id')
  @Roles(...ALL_ROLES)
  @RequirePermissions('agenda_manage')
  deletePlan(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.plans.remove(req.user, id);
  }
}
