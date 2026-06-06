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
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CompleteInstallationTaskDto } from './dto/complete-installation-task.dto';
import { CreateInstallationPlanDto } from './dto/create-installation-plan.dto';
import { ReorderInstallationTasksDto } from './dto/reorder-tasks.dto';
import { UpdateInstallationPlanDto } from './dto/update-installation-plan.dto';
import { UpsertInstallationTaskDto } from './dto/upsert-installation-task.dto';
import { InstallationsService } from './installations.service';

/**
 * V1.15 — Plannings d'installation.
 *
 * Lecture : SUPER_ADMIN (tout) + FLEET_ADMIN (sa flotte, plans publies).
 * Gestion : SUPER_ADMIN uniquement. Exception : le reordonnancement du sens
 * d'installation est ouvert au FLEET_ADMIN (sur sa flotte).
 */
@Controller('installations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InstallationsController {
  constructor(private readonly installations: InstallationsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  list(@Req() req: AuthenticatedRequest) {
    return this.installations.list(this.rb(req));
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  findOne(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.installations.findOne(id, this.rb(req));
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN)
  create(@Body() dto: CreateInstallationPlanDto) {
    return this.installations.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateInstallationPlanDto) {
    return this.installations.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.SUPER_ADMIN)
  remove(@Param('id') id: string) {
    return this.installations.remove(id);
  }

  /** Reordonnancement du sens d'installation — ouvert au FLEET_ADMIN de la flotte. */
  @Patch(':id/reorder')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  reorder(
    @Param('id') id: string,
    @Body() dto: ReorderInstallationTasksDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.installations.reorderTasks(id, dto, this.rb(req));
  }

  @Post(':id/tasks')
  @Roles(UserRole.SUPER_ADMIN)
  addTask(@Param('id') id: string, @Body() dto: UpsertInstallationTaskDto) {
    return this.installations.addTask(id, dto);
  }

  @Patch(':id/tasks/:taskId')
  @Roles(UserRole.SUPER_ADMIN)
  updateTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: UpsertInstallationTaskDto,
  ) {
    return this.installations.updateTask(id, taskId, dto);
  }

  @Delete(':id/tasks/:taskId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(UserRole.SUPER_ADMIN)
  removeTask(@Param('id') id: string, @Param('taskId') taskId: string) {
    return this.installations.removeTask(id, taskId);
  }

  /** Pose : capture IMEI/SIM/notes + provisioning auto du Vehicle + Tracker. */
  @Post(':id/tasks/:taskId/complete')
  @Roles(UserRole.SUPER_ADMIN)
  completeTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() dto: CompleteInstallationTaskDto,
  ) {
    return this.installations.completeTask(id, taskId, dto);
  }

  /** Resync/retry manuel du provisioning d'une tache deja posee. */
  @Post(':id/tasks/:taskId/provision')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN)
  provision(@Param('id') id: string, @Param('taskId') taskId: string) {
    return this.installations.provision(id, taskId);
  }

  private rb(req: AuthenticatedRequest) {
    return { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId };
  }
}
