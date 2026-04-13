import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';

interface UnifiedCommand {
  id: string;
  type: 'engine' | 'tracker';
  action?: string;
  templateId?: string;
  category?: string;
  payload?: string;
  status: string;
  reason?: string | null;
  lastError?: string | null;
  ackResponse?: string | null;
  requestedBy: string;
  createdAt: Date;
  sentAt?: Date | null;
}

@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CommandsHistoryController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':vehicleId/commands-history')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  async unified(
    @Param('vehicleId') vehicleId: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<UnifiedCommand[]> {
    const take = Math.min(parseInt(limit ?? '50', 10) || 50, 200);

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      include: { tracker: true },
    });

    if (!vehicle?.tracker) return [];

    if (req?.user.role !== UserRole.SUPER_ADMIN && vehicle.fleetId !== req?.user.fleetId) {
      return [];
    }

    const trackerId = vehicle.tracker.id;

    const [engineCmds, trackerCmds] = await Promise.all([
      this.prisma.engineControlCommand.findMany({
        where: { trackerId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.trackerCommand.findMany({
        where: { trackerId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    ]);

    const unified: UnifiedCommand[] = [
      ...engineCmds.map((c) => ({
        id: c.id,
        type: 'engine' as const,
        action: c.action,
        status: c.status,
        reason: c.reason,
        lastError: c.lastError,
        requestedBy: c.requestedBy,
        createdAt: c.createdAt,
        sentAt: c.sentAt,
      })),
      ...trackerCmds.map((c) => ({
        id: c.id,
        type: 'tracker' as const,
        templateId: c.templateId,
        category: c.category,
        payload: c.payload,
        status: c.status,
        lastError: c.lastError,
        ackResponse: c.ackResponse,
        requestedBy: c.requestedBy,
        createdAt: c.createdAt,
        sentAt: c.sentAt,
      })),
    ];

    unified.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return unified.slice(0, take);
  }
}
