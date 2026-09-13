import { Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BackgroundTasksService } from './background-tasks.service';
import { PauseAgentsLocauxService } from './pause-agents-locaux.service';

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
  constructor(
    private readonly service: BackgroundTasksService,
    private readonly pauses: PauseAgentsLocauxService,
  ) {}

  @Get()
  list() {
    return this.service.list();
  }

  /**
   * T34 / D5 — « Reprendre maintenant » : lève la pause des agents du poste. Le prochain passage
   * planifié (au plus deux heures) travaille ; rien ne se lance d'ici, les agents tournent sur le
   * poste. Le geste est signé de l'utilisateur, et rend le nombre de lignes fermées (0 = il n'y
   * avait plus rien à lever, ce n'est pas une erreur).
   */
  @Post('agents-locaux/reprendre')
  @HttpCode(200)
  async reprendre(@Req() req: AuthenticatedRequest): Promise<{ levees: number }> {
    const levees = await this.pauses.lever(`admin:${req.user.id}`);
    return { levees };
  }
}
