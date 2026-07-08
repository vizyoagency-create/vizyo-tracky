import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BackgroundTasksService } from './background-tasks.service';

/**
 * Demande CDEF (2026-07) — Module admin « Automatisations & tâches de fond ».
 * Réservé au SUPER_ADMIN (observabilité plateforme). Lecture seule : liste tout ce qui
 * tourne en arrière-plan + prochain lancement + drift. Les réglages restent sur leurs
 * pages dédiées (liens fournis par le service).
 */
@Controller('admin/background-tasks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class BackgroundTasksController {
  constructor(private readonly service: BackgroundTasksService) {}

  @Get()
  list() {
    return this.service.list();
  }
}
