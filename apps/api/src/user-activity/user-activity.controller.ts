import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ErrorLogger } from '../observability/error-logger.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { ActivityBatchDto, ClientErrorDto } from './dto/track-event.dto';
import { UserActivityService } from './user-activity.service';

/**
 * User activity tracking.
 *  - POST /api/activity/batch  : ingestion (TOUT user authentifié envoie ses events).
 *  - GET  /api/admin/activity/* : lecture (SUPER_ADMIN only).
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class UserActivityController {
  constructor(
    private readonly svc: UserActivityService,
    private readonly errorLogger: ErrorLogger,
    private readonly system: SystemActivityService,
  ) {}

  @Post('activity/batch')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async batch(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ActivityBatchDto,
  ): Promise<{ ok: true }> {
    await this.svc.ingestBatch(req.user, dto, {
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    return { ok: true };
  }

  /** Remontée d'une erreur frontend → ErrorLog enrichi (visible centre d'alerte). */
  @Post('activity/error')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async reportError(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ClientErrorDto,
  ): Promise<{ ok: true }> {
    const user = req.user;
    const err = new Error(dto.message || 'Frontend error');
    if (dto.stack) err.stack = dto.stack;
    await this.errorLogger.record(
      err,
      'frontend',
      {
        userId: user.id,
        userEmail: user.email,
        fleetId: user.fleetId ?? undefined,
        route: dto.route,
        page: dto.route,
        sessionId: dto.sessionId,
        userAgent: req.headers['user-agent'] as string | undefined,
        httpUrl: dto.httpUrl,
        httpStatus: dto.httpStatus,
      },
      'ERROR',
    );
    return { ok: true };
  }

  @Get('admin/activity/online')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  online() {
    return this.svc.getOnline();
  }

  @Get('admin/activity/feed')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  feed(@Query('limit') limit?: string, @Query('before') before?: string) {
    return this.svc.getFeed(limit ? parseInt(limit, 10) || 50 : 50, before);
  }

  @Get('admin/activity/stats')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  stats(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.getStats(from, to);
  }

  /** Audit des commandes moteur (coupe-circuit) — historique paginé pour l'admin. */
  @Get('admin/activity/engine-commands')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  engineCommands(
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('action') action?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.getEngineCommands({
      limit: limit ? parseInt(limit, 10) || 50 : 50,
      before,
      action,
      status,
    });
  }

  /**
   * Palier B — journal des actions AUTOMATIQUES / système (arrière-plan) :
   * e-mails, SMS, notifications push, commandes moteur, purges de rétention,
   * rapports IA planifiés. Distinct du feed d'activité MANUELLE (front).
   */
  @Get('admin/activity/system')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  systemFeed(
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('category') category?: string,
  ) {
    return this.system.getFeed({
      limit: limit ? parseInt(limit, 10) || 60 : 60,
      before,
      category,
    });
  }
}
