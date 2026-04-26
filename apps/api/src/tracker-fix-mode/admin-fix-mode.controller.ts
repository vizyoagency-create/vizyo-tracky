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
import { TrackerFixModeService } from './tracker-fix-mode.service';

/**
 * V1.5 (Sprint H3) — Admin endpoint pour la page `/admin/trackers/:id/fix-mode`.
 *
 *  - GET /state       : bandeau d'etat (desired/current, badge OK/PENDING/FAILING)
 *  - GET /timeline    : commandes fix mode des 90 derniers jours, avec snapshot
 *  - POST /override   : pose un override admin (forcer fix030s pour 24h, etc.)
 */
@Controller('admin/trackers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminFixModeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fixMode: TrackerFixModeService,
  ) {}

  @Get(':id/fix-mode/state')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async state(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) trackerId: string,
  ) {
    const tracker = await this.assertAccess(req, trackerId);
    return {
      trackerId: tracker.id,
      imei: tracker.imei,
      vehiclePlate: tracker.vehicle?.plate ?? null,
      desiredFixIntervalS: tracker.desiredFixIntervalS,
      currentFixIntervalS: tracker.currentFixIntervalS,
      lastFixIntervalSyncAt: tracker.lastFixIntervalSyncAt?.toISOString() ?? null,
      lastValidFrameAt: tracker.lastValidFrameAt?.toISOString() ?? null,
      lastSeenAt: tracker.lastSeenAt?.toISOString() ?? null,
      status: tracker.status,
      fixCommandFailureCount: tracker.fixCommandFailureCount,
      fixCommandFailing: tracker.fixCommandFailing,
      fixModeOverrideUntil: tracker.fixModeOverrideUntil?.toISOString() ?? null,
      lastSampledState: tracker.lastSampledState,
      adaptiveFixModeEnabled: tracker.vehicle?.fleet?.adaptiveFixModeEnabled ?? true,
    };
  }

  @Get(':id/fix-mode/timeline')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async timeline(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) trackerId: string,
    @Query('days') daysRaw?: string,
    @Query('outcome') outcomeFilter?: string,
  ) {
    await this.assertAccess(req, trackerId);
    const days = Math.max(1, Math.min(parseInt(daysRaw ?? '90', 10) || 90, 90));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const where: Record<string, unknown> = {
      trackerId,
      category: 'reporting',
      templateId: 'fix_continuous',
      createdAt: { gte: since },
    };
    if (outcomeFilter === 'failed') where.status = 'FAILED';
    if (outcomeFilter === 'pending') where.status = { in: ['PENDING', 'SENT'] };

    const items = await this.prisma.trackerCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 300,
    });

    return {
      days,
      items: items.map((c) => ({
        id: c.id,
        templateId: c.templateId,
        params: c.params,
        payload: c.payload,
        channel: c.channel,
        status: c.status,
        outcomeReason: c.outcomeReason,
        expectedResult: c.expectedResult,
        observedResult: c.observedResult,
        diagnosticHint: c.diagnosticHint,
        contextSnapshot: c.contextSnapshot,
        lastError: c.lastError,
        sentAt: c.sentAt?.toISOString() ?? null,
        ackedAt: c.ackedAt?.toISOString() ?? null,
        ackResponse: c.ackResponse,
        acknowledgedBy: c.acknowledgedBy,
        acknowledgedAt: c.acknowledgedAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  @Post(':id/fix-mode/override')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async setOverride(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) trackerId: string,
    @Body() body: { durationMinutes?: number; intervalS?: number | null },
  ) {
    await this.assertAccess(req, trackerId);

    const minutes = body?.durationMinutes ?? 0;
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) {
      throw new BadRequestException('durationMinutes doit etre entre 0 et 1440 (24h)');
    }
    const intervalS = body?.intervalS ?? null;
    if (intervalS !== null && (!Number.isFinite(intervalS) || intervalS < 30 || intervalS > 300)) {
      throw new BadRequestException('intervalS doit etre entre 30 et 300 si fourni');
    }

    return this.fixMode.setManualOverride(trackerId, minutes, intervalS, req.user.id);
  }

  private async assertAccess(req: AuthenticatedRequest, trackerId: string) {
    const tracker = await this.prisma.tracker.findUnique({
      where: { id: trackerId },
      include: { vehicle: { include: { fleet: true } } },
    });
    if (!tracker) throw new NotFoundException('Tracker introuvable');
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (!tracker.vehicle || tracker.vehicle.fleetId !== req.user.fleetId) {
        throw new ForbiddenException('Acces refuse');
      }
    }
    return tracker;
  }
}
