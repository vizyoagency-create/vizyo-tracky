import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { SentinellesCoherenceService } from './sentinelles-coherence.service';

@Controller('admin/logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminLogsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sentinelles: SentinellesCoherenceService,
  ) {}

  /**
   * Lot V6 — DÉCLENCHER les sentinelles maintenant, sans attendre le passage de 06:30.
   *
   * Sans cette route, vérifier qu'une sentinelle voit juste demanderait d'attendre le lendemain
   * — et un instrument qu'on ne peut pas éprouver le jour où on l'écrit est un instrument
   * qu'on ne croit pas.
   *
   * ⚠️ Le passage est RÉEL : il consomme les refroidissements et écrit au centre d'alerte, comme
   * la tâche planifiée. La réponse rend les constats trouvés ET ceux que le refroidissement a
   * retenus, pour que « rien d'écrit » ne se confonde jamais avec « rien à dire ».
   */
  @Post('sentinelles/run')
  async lancerSentinelles() {
    return this.sentinelles.passage();
  }

  @Get('wire')
  async listWireLogs(
    @Query('imei') imei?: string,
    @Query('commandId') commandId?: string,
    @Query('direction') direction?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(parseInt(limit ?? '50', 10) || 50, 200);
    const where: Record<string, unknown> = {};

    if (imei) where.imei = imei;
    if (commandId) where.commandId = commandId;
    if (direction) where.direction = direction;
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.wireLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.wireLog.count({ where }),
    ]);

    return { items, total };
  }

  @Get('wire/:id')
  async getWireLog(@Param('id') id: string) {
    return this.prisma.wireLog.findUniqueOrThrow({ where: { id } });
  }

  @Get('errors')
  async listErrorLogs(
    @Query('source') source?: string,
    @Query('imei') imei?: string,
    @Query('level') level?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(parseInt(limit ?? '50', 10) || 50, 200);
    const where: Record<string, unknown> = {};

    if (source) where.source = source;
    if (imei) where.imei = imei;
    if (level) where.level = level;
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.errorLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.errorLog.count({ where }),
    ]);

    return { items, total };
  }

  @Get('errors/:id')
  async getErrorLog(@Param('id') id: string) {
    return this.prisma.errorLog.findUniqueOrThrow({ where: { id } });
  }

  @Get('tracker/:imei/timeline')
  async trackerTimeline(
    @Param('imei') imei: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(parseInt(limit ?? '100', 10) || 100, 500);

    const [wireLogs, errorLogs] = await Promise.all([
      this.prisma.wireLog.findMany({
        where: { imei },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.errorLog.findMany({
        where: { imei },
        orderBy: { createdAt: 'desc' },
        take: Math.floor(take / 2),
      }),
    ]);

    const timeline = [
      ...wireLogs.map((w) => ({ type: 'wire' as const, id: w.id, createdAt: w.createdAt, direction: w.direction, frameType: w.frameType, raw: w.raw, commandId: w.commandId })),
      ...errorLogs.map((e) => ({ type: 'error' as const, id: e.id, createdAt: e.createdAt, level: e.level, source: e.source, message: e.message })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take);

    return { items: timeline };
  }
}
