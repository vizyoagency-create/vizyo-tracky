import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ActivityBatchDto } from './dto/track-event.dto';
import { UserActivityService } from './user-activity.service';

/**
 * User activity tracking.
 *  - POST /api/activity/batch  : ingestion (TOUT user authentifié envoie ses events).
 *  - GET  /api/admin/activity/* : lecture (SUPER_ADMIN only).
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class UserActivityController {
  constructor(private readonly svc: UserActivityService) {}

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
}
