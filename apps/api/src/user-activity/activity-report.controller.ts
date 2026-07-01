import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ActivityReportService } from './activity-report.service';
import { GenerateActivityReportBodyDto, SetActivityReportScheduleBodyDto } from './dto/activity-report-body.dto';

/**
 * Palier 3 — Rapports d'observation IA de l'activité (SUPER_ADMIN). Génération à la demande,
 * historique persisté, planification réglable.
 */
@Controller('admin/activity/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class ActivityReportController {
  constructor(private readonly svc: ActivityReportService) {}

  /** Liste des rapports (les plus récents d'abord). */
  @Get()
  list(@Query('limit') limit?: string) {
    return this.svc.list(limit ? parseInt(limit, 10) || 30 : 30);
  }

  /** Planification courante (déclarée AVANT :id pour ne pas être capturée comme un id). */
  @Get('schedule')
  schedule() {
    return this.svc.getSchedule();
  }

  @Put('schedule')
  setSchedule(@Body() dto: SetActivityReportScheduleBodyDto, @Req() req: AuthenticatedRequest) {
    return this.svc.setSchedule(dto, req.user.id);
  }

  /** Génère un rapport à la demande (users + période). */
  @Post('generate')
  generate(@Body() dto: GenerateActivityReportBodyDto, @Req() req: AuthenticatedRequest) {
    return this.svc.generate({ id: req.user.id, fleetId: req.user.fleetId ?? null }, dto, 'manual');
  }

  /** Détail d'un rapport. */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }
}
