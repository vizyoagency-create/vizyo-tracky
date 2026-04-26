import {
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
import { TrackerCommandStatus, UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';

const OFFLINE_THRESHOLD_MS = 60 * 60 * 1000; // 1h
const PENDING_THRESHOLD_MS = 10 * 60 * 1000; // 10 min

/**
 * V1.5 (Sprint H3) — Admin alerts center (`/api/admin/alerts`).
 *
 * Aggregates trackers requiring operator attention :
 *  - fixCommandFailing = true (3 commandes consecutives sans effet)
 *  - status = OFFLINE depuis > 1h
 *  - commandes PENDING / SENT depuis > 10 min sans ACK
 *
 * Tenant isolation : SUPER_ADMIN voit toutes les fleets, FLEET_ADMIN seulement
 * les trackers de sa fleet.
 */
@Controller('admin/alerts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminAlertsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async list(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetIdFilter?: string) {
    const isSuperAdmin = req.user.role === UserRole.SUPER_ADMIN;
    const fleetIdScope = isSuperAdmin ? fleetIdFilter ?? undefined : req.user.fleetId ?? undefined;
    const fleetClause = fleetIdScope ? { vehicle: { fleetId: fleetIdScope } } : {};

    const offlineCutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
    const pendingCutoff = new Date(Date.now() - PENDING_THRESHOLD_MS);

    const [failingTrackers, offlineTrackers, pendingCommands] = await Promise.all([
      this.prisma.tracker.findMany({
        where: { fixCommandFailing: true, ...fleetClause },
        include: { vehicle: { include: { fleet: true } } },
        take: 200,
      }),
      this.prisma.tracker.findMany({
        where: {
          status: 'OFFLINE',
          OR: [{ lastSeenAt: { lt: offlineCutoff } }, { lastSeenAt: null }],
          ...fleetClause,
        },
        include: { vehicle: { include: { fleet: true } } },
        take: 200,
      }),
      this.prisma.trackerCommand.findMany({
        where: {
          status: { in: [TrackerCommandStatus.PENDING, TrackerCommandStatus.SENT] },
          createdAt: { lt: pendingCutoff },
          acknowledgedAt: null,
          ...(fleetIdScope ? { tracker: { vehicle: { fleetId: fleetIdScope } } } : {}),
        },
        include: { tracker: { include: { vehicle: { include: { fleet: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);

    return {
      summary: {
        failing: failingTrackers.length,
        offline: offlineTrackers.length,
        pending: pendingCommands.length,
      },
      failing: failingTrackers.map((t) => ({
        kind: 'TRACKER_FAILING' as const,
        trackerId: t.id,
        imei: t.imei,
        vehicleId: t.vehicle?.id ?? null,
        plate: t.vehicle?.plate ?? null,
        fleetId: t.vehicle?.fleetId ?? null,
        fleetName: t.vehicle?.fleet?.name ?? null,
        fixCommandFailureCount: t.fixCommandFailureCount,
        desiredFixIntervalS: t.desiredFixIntervalS,
        currentFixIntervalS: t.currentFixIntervalS,
        lastSeenAt: t.lastSeenAt?.toISOString() ?? null,
        lastFixIntervalSyncAt: t.lastFixIntervalSyncAt?.toISOString() ?? null,
      })),
      offline: offlineTrackers.map((t) => ({
        kind: 'TRACKER_OFFLINE' as const,
        trackerId: t.id,
        imei: t.imei,
        vehicleId: t.vehicle?.id ?? null,
        plate: t.vehicle?.plate ?? null,
        fleetId: t.vehicle?.fleetId ?? null,
        fleetName: t.vehicle?.fleet?.name ?? null,
        lastSeenAt: t.lastSeenAt?.toISOString() ?? null,
        offlineSinceMs: t.lastSeenAt ? Date.now() - t.lastSeenAt.getTime() : null,
      })),
      pendingCommands: pendingCommands.map((c) => ({
        kind: 'COMMAND_PENDING' as const,
        commandId: c.id,
        trackerId: c.trackerId,
        imei: c.tracker.imei,
        vehicleId: c.tracker.vehicle?.id ?? null,
        plate: c.tracker.vehicle?.plate ?? null,
        fleetId: c.tracker.vehicle?.fleetId ?? null,
        fleetName: c.tracker.vehicle?.fleet?.name ?? null,
        category: c.category,
        templateId: c.templateId,
        status: c.status,
        sentAt: c.sentAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        diagnosticHint: c.diagnosticHint,
        outcomeReason: c.outcomeReason,
      })),
    };
  }

  @Post('commands/:id/acknowledge')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async acknowledgeCommand(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) commandId: string,
    @Body() body: { note?: string },
  ) {
    const command = await this.prisma.trackerCommand.findUnique({
      where: { id: commandId },
      include: { tracker: { include: { vehicle: true } } },
    });
    if (!command) throw new NotFoundException('Commande introuvable');
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      const fleetId = command.tracker.vehicle?.fleetId;
      if (fleetId !== req.user.fleetId) throw new ForbiddenException('Acces refuse');
    }

    return this.prisma.trackerCommand.update({
      where: { id: commandId },
      data: {
        acknowledgedBy: req.user.id,
        acknowledgedAt: new Date(),
        outcomeReason: body?.note ? `${command.outcomeReason ?? ''}\n[ACK] ${body.note}`.trim() : command.outcomeReason,
      },
    });
  }

  /**
   * Reset the FAILING flag on a tracker — admin says "I've checked, problem is gone"
   * (e.g. boitier reboote, SIM data restoree). Resets the failure counter to 0.
   */
  @Post('trackers/:id/clear-failing')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async clearFailing(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) trackerId: string,
  ) {
    const tracker = await this.prisma.tracker.findUnique({
      where: { id: trackerId },
      include: { vehicle: true },
    });
    if (!tracker) throw new NotFoundException('Tracker introuvable');
    if (req.user.role !== UserRole.SUPER_ADMIN) {
      if (tracker.vehicle?.fleetId !== req.user.fleetId) throw new ForbiddenException('Acces refuse');
    }
    await this.prisma.tracker.update({
      where: { id: trackerId },
      data: { fixCommandFailing: false, fixCommandFailureCount: 0 },
    });
    return { ok: true };
  }
}
