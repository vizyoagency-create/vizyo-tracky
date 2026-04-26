import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PositionSamplingService } from './position-sampling.service';

const MAX_RANGE_HOURS = 24 * 7; // audit retention is 7 days

/**
 * V1.5 (Sprint H1) — Admin observability for adaptive sampling.
 *
 * SUPER_ADMIN sees all trackers ; FLEET_ADMIN sees only their fleet's trackers.
 * Routes are scoped under `/admin/...` for clarity, even though the actual
 * permissioning is enforced via guards + tenant check below.
 */
@Controller('admin/trackers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminSamplingController {
  constructor(
    private readonly sampling: PositionSamplingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id/sampling/stats')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async stats(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) trackerId: string,
    @Query('rangeHours') rangeHoursRaw?: string,
  ) {
    await this.assertAccess(req, trackerId);
    const rangeHours = this.parseRangeHours(rangeHoursRaw);
    return this.sampling.getStats(trackerId, rangeHours);
  }

  @Get(':id/sampling/histogram')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async histogram(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) trackerId: string,
    @Query('days') daysRaw?: string,
  ) {
    await this.assertAccess(req, trackerId);
    const days = Math.max(1, Math.min(parseInt(daysRaw ?? '7', 10) || 7, 7));
    return { days, buckets: await this.sampling.getHourlyHistogram(trackerId, days) };
  }

  @Get(':id/sampling/recent')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async recent(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) trackerId: string,
    @Query('limit') limitRaw?: string,
  ) {
    await this.assertAccess(req, trackerId);
    const limit = Math.max(1, Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200));
    return { items: await this.sampling.getRecentDecisions(trackerId, limit) };
  }

  @Post(':id/sampling/verbose')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async toggleVerbose(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) trackerId: string,
    @Body() body: { durationMinutes?: number },
  ) {
    await this.assertAccess(req, trackerId);
    const minutes = typeof body?.durationMinutes === 'number' ? body.durationMinutes : 0;
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) {
      throw new BadRequestException('durationMinutes doit etre entre 0 et 1440 (24h)');
    }
    return this.sampling.setVerboseMode(trackerId, minutes);
  }

  private parseRangeHours(raw: string | undefined): number {
    const parsed = parseInt(raw ?? '24', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 24;
    return Math.min(parsed, MAX_RANGE_HOURS);
  }

  private async assertAccess(req: AuthenticatedRequest, trackerId: string): Promise<void> {
    if (req.user.role === UserRole.SUPER_ADMIN) return;

    const tracker = await this.prisma.tracker.findUnique({
      where: { id: trackerId },
      include: { vehicle: true },
    });
    if (!tracker) throw new NotFoundException('Tracker introuvable');
    if (!tracker.vehicle || tracker.vehicle.fleetId !== req.user.fleetId) {
      throw new ForbiddenException('Acces refuse');
    }
  }
}
