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
const ERROR_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const CRITICAL_WINDOW_MS = 60 * 60 * 1000;   // 1h

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
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetIdFilter?: string,
    @Query('since') sinceRaw?: string,
  ) {
    const isSuperAdmin = req.user.role === UserRole.SUPER_ADMIN;
    const fleetIdScope = isSuperAdmin ? fleetIdFilter ?? undefined : req.user.fleetId ?? undefined;
    const fleetClause = fleetIdScope ? { vehicle: { fleetId: fleetIdScope } } : {};

    const now = Date.now();
    const offlineCutoff = new Date(now - OFFLINE_THRESHOLD_MS);
    const pendingCutoff = new Date(now - PENDING_THRESHOLD_MS);
    const errorCutoff = new Date(now - ERROR_WINDOW_MS);
    const errorPrevCutoff = new Date(now - 2 * ERROR_WINDOW_MS);
    const criticalCutoff = new Date(now - CRITICAL_WINDOW_MS);
    const sinceCutoff = sinceRaw ? new Date(sinceRaw) : null;

    const [failingTrackers, offlineTrackers, pendingCommands, errorLogs24h, criticalCount, errorsPrev24h, errorsSince] = await Promise.all([
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
      // V1.14 — Erreurs applicatives (24h) pour le centre d'alertes.
      this.prisma.errorLog.findMany({
        where: { createdAt: { gte: errorCutoff } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.prisma.errorLog.count({
        where: { level: 'CRITICAL', createdAt: { gte: criticalCutoff } },
      }),
      // Tendance : count erreurs 24h precedentes (pour comparaison).
      this.prisma.errorLog.count({
        where: { createdAt: { gte: errorPrevCutoff, lt: errorCutoff } },
      }),
      // Count depuis derniere visite (si fourni).
      sinceCutoff
        ? this.prisma.errorLog.count({ where: { createdAt: { gte: sinceCutoff } } })
        : Promise.resolve(null as number | null),
    ]);

    // Agréger les erreurs par source.
    const bySourceMap = new Map<string, { count: number; lastAt: Date }>();
    for (const e of errorLogs24h) {
      const existing = bySourceMap.get(e.source);
      if (!existing) {
        bySourceMap.set(e.source, { count: 1, lastAt: e.createdAt });
      } else {
        existing.count++;
        if (e.createdAt > existing.lastAt) existing.lastAt = e.createdAt;
      }
    }
    const bySource = Array.from(bySourceMap.entries())
      .map(([source, { count, lastAt }]) => ({ source, count, lastAt: lastAt.toISOString() }))
      .sort((a, b) => b.count - a.count);

    // Top messages dédupliqués (première ligne du message comme clé).
    const byMessageMap = new Map<string, { message: string; source: string; count: number; level: string; lastAt: Date; lastId: string }>();
    for (const e of errorLogs24h) {
      const key = `${e.source}::${e.message.split('\n')[0].slice(0, 200)}`;
      const existing = byMessageMap.get(key);
      if (!existing) {
        byMessageMap.set(key, {
          message: e.message.split('\n')[0].slice(0, 200),
          source: e.source,
          count: 1,
          level: e.level,
          lastAt: e.createdAt,
          lastId: e.id,
        });
      } else {
        existing.count++;
        if (e.level === 'CRITICAL') existing.level = 'CRITICAL';
        if (e.createdAt > existing.lastAt) {
          existing.lastAt = e.createdAt;
          existing.lastId = e.id;
        }
      }
    }
    const topMessages = Array.from(byMessageMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((m) => ({
        message: m.message,
        source: m.source,
        count: m.count,
        level: m.level,
        lastAt: m.lastAt.toISOString(),
        lastId: m.lastId,
      }));

    // Dernières erreurs CRITICAL (10 max).
    const recentCritical = errorLogs24h
      .filter((e) => e.level === 'CRITICAL')
      .slice(0, 10)
      .map((e) => ({
        id: e.id,
        level: e.level,
        source: e.source,
        message: e.message.split('\n')[0].slice(0, 300),
        stack: e.stack?.slice(0, 500) ?? null,
        imei: e.imei,
        context: e.context,
        createdAt: e.createdAt.toISOString(),
      }));

    return {
      summary: {
        failing: failingTrackers.length,
        offline: offlineTrackers.length,
        pending: pendingCommands.length,
        errorsLast24h: errorLogs24h.length,
        errorsPrev24h,
        criticalLastHour: criticalCount,
        errorsSinceLastVisit: errorsSince,
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
      errors: {
        last24h: errorLogs24h.length,
        criticalLastHour: criticalCount,
        bySource,
        topMessages,
        recentCritical,
      },
    };
  }

  /**
   * V1.14 — Timeline d'erreurs agregees par heure (24h) pour le graphique
   * du centre d'alertes. Retourne 24 buckets avec le count ERROR + CRITICAL.
   */
  @Get('errors/timeline')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async errorsTimeline() {
    const since = new Date(Date.now() - ERROR_WINDOW_MS);
    const rows = await this.prisma.$queryRaw<
      Array<{ hour: Date; level: string; count: bigint }>
    >`
      SELECT date_trunc('hour', "createdAt") AS hour, level, COUNT(*) AS count
      FROM error_logs
      WHERE "createdAt" >= ${since}
      GROUP BY hour, level
      ORDER BY hour ASC
    `;

    // Construire 24 buckets vides puis remplir avec les données.
    const buckets: Array<{ hour: string; error: number; critical: number }> = [];
    const now = new Date();
    for (let i = 23; i >= 0; i--) {
      const h = new Date(now);
      h.setMinutes(0, 0, 0);
      h.setHours(h.getHours() - i);
      buckets.push({ hour: h.toISOString(), error: 0, critical: 0 });
    }

    for (const row of rows) {
      const hourKey = new Date(row.hour);
      hourKey.setMinutes(0, 0, 0);
      const bucket = buckets.find(
        (b) => new Date(b.hour).getTime() === hourKey.getTime(),
      );
      if (bucket) {
        const count = Number(row.count);
        if (row.level === 'CRITICAL') bucket.critical += count;
        else bucket.error += count;
      }
    }

    return { buckets };
  }

  /**
   * V1.14 — Export markdown structure pour debug IA (Claude).
   * Retourne un rapport formaté contenant les erreurs des dernières 24h
   * avec stack traces, contexte, et résumé par source.
   */
  @Get('errors/export')
  @Roles(UserRole.SUPER_ADMIN)
  async errorsExport() {
    const since = new Date(Date.now() - ERROR_WINDOW_MS);
    const errors = await this.prisma.errorLog.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const criticalCount = errors.filter((e) => e.level === 'CRITICAL').length;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Résumé par source.
    const sourceMap = new Map<string, { count: number; lastAt: string }>();
    for (const e of errors) {
      const existing = sourceMap.get(e.source);
      if (!existing) {
        sourceMap.set(e.source, { count: 1, lastAt: e.createdAt.toISOString() });
      } else {
        existing.count++;
      }
    }

    let md = `# Rapport d'erreurs — Vizyo Tracky\n`;
    md += `Periode : dernieres 24h | Genere le : ${now} UTC\n`;
    md += `Erreurs : ${errors.length} (dont ${criticalCount} CRITICAL)\n\n`;

    md += `## Resume par source\n`;
    md += `| Source | Count | Derniere |\n|--------|-------|----------|\n`;
    for (const [source, data] of sourceMap.entries()) {
      md += `| ${source} | ${data.count} | ${data.lastAt.slice(0, 19).replace('T', ' ')} |\n`;
    }
    md += `\n`;

    for (let i = 0; i < errors.length; i++) {
      const e = errors[i];
      md += `## Erreur #${i + 1} — ${e.level}\n`;
      md += `- **Source :** ${e.source}\n`;
      md += `- **Date :** ${e.createdAt.toISOString().slice(0, 19).replace('T', ' ')} UTC\n`;
      md += `- **Message :** ${e.message}\n`;
      if (e.imei) md += `- **IMEI :** ${e.imei}\n`;
      if (e.commandId) md += `- **CommandId :** ${e.commandId}\n`;
      if (e.userId) md += `- **UserId :** ${e.userId}\n`;
      if (e.stack) md += `\n\`\`\`\n${e.stack}\n\`\`\`\n`;
      if (e.context) md += `\n**Contexte :**\n\`\`\`json\n${JSON.stringify(e.context, null, 2)}\n\`\`\`\n`;
      md += `\n---\n\n`;
    }

    return {
      markdown: md,
      errorCount: errors.length,
      criticalCount,
      window: '24h',
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
