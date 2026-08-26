import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CommandStatus, UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireVehiclePermission } from '../auth/decorators/vehicle-permissions.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { RequestEngineCommandDto } from './dto/request-engine-command.dto';
import { EngineControlService } from './engine-control.service';

@Controller('engine-control')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class EngineControlController {
  constructor(private readonly engineControl: EngineControlService) {}

  /**
   * V1.11 Phase 1 — Coupure/redemarrage moteur protege par la permission
   * `engine_control` resolue per-vehicle (regle "specifique gagne"). Ouvert aux
   * 4 roles mais @RequireVehiclePermission filtre selon les overrides.
   *
   * Les contraintes metier (vitesse < 20 km/h, position fraiche, fix GPS valide)
   * sont appliquees dans le service apres le passage du guard.
   */
  @Post('trackers/:trackerId/commands')
  @Roles(
    UserRole.FLEET_ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.FLEET_MANAGER,
    UserRole.VIEWER,
    UserRole.NIGHT_WATCHMAN,
  )
  @RequireVehiclePermission('engine_control', { paramName: 'trackerId' })
  requestCommand(
    @Param('trackerId') trackerId: string,
    @Body() dto: RequestEngineCommandDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.engineControl.requestCommand(trackerId, dto.action, dto.reason ?? null, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    }, 'MANUAL', dto.disableSchedule);
  }

  @Get('commands')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  listCommands(
    @Req() req: AuthenticatedRequest,
    @Query('trackerId') trackerId?: string,
    @Query('status') status?: CommandStatus,
    @Query('limit') limit?: string,
  ) {
    return this.engineControl.listCommands(
      {
        userId: req.user.id,
        role: req.user.role,
        fleetId: req.user.fleetId,
      },
      {
        trackerId,
        status,
        limit: limit ? parseInt(limit, 10) : undefined,
      },
    );
  }

  /**
   * TRK-018 nº 4 — l'écran « immobilisations non confirmées ».
   *
   * Volontairement AVANT `commands/:id` : Nest résout dans l'ordre de déclaration, et une route
   * littérale placée après une route paramétrée serait avalée par elle (`:id` = 'unconfirmed').
   *
   * Ouvert aux mêmes rôles que la liste des commandes. Le cloisonnement est fait dans le service
   * par `resolveTenantScope` (fail-closed).
   */
  @Get('unconfirmed')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  listUnconfirmed(@Req() req: AuthenticatedRequest, @Query('days') days?: string) {
    return this.engineControl.listUnconfirmedImmobilisations(
      { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId },
      { days: days ? parseInt(days, 10) : undefined },
    );
  }

  @Get('commands/:id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  getCommand(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.engineControl.getCommand(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }
}
