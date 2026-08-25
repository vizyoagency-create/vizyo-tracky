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
import { BadRequestException, DefaultValuePipe, ParseBoolPipe } from '@nestjs/common';
import { TrackerCommandStatus, UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { resolveTenantScope } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { cadenceMesurePerimee } from './peremption-cadence';

const OFFLINE_THRESHOLD_MS = 60 * 60 * 1000; // 1h
const PENDING_THRESHOLD_MS = 10 * 60 * 1000; // 10 min
const ERROR_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const CRITICAL_WINDOW_MS = 60 * 60 * 1000;   // 1h

/**
 * TRK-009 — un boîtier JAMAIS vu ne compte comme « hors ligne » que s'il est RATTACHÉ à un
 * véhicule.
 *
 * Sans véhicule et sans la moindre trame, c'est du matériel en stock : il n'est pas tombé,
 * il ne s'est jamais levé. Trois boîtiers dans ce cas gonflaient d'un tiers le compteur
 * « hors ligne > 1 h » avec du matériel en parfait état — un compteur qu'on regarde pour
 * décider d'intervenir.
 *
 * ⚠️ Un boîtier jamais vu MAIS rattaché à un véhicule reste signalé : là, c'est une pose qui
 * a échoué, et c'est un vrai signal.
 */
/**
 * ARCHIVAGE — plafond d'un archivage en masse.
 *
 * Un « tout archiver » sans borne est une suppression deguisee : personne ne relit
 * 5 000 lignes avant de cliquer. Au-dela, l'appel ECHOUE plutot que d'en faire une
 * partie en silence — un archivage partiel qu'on croit total est pire que le refus.
 */
const ARCHIVAGE_MASSE_MAX = 500;

const OFFLINE_NEVER_SEEN_CLAUSE = { lastSeenAt: null, vehicleId: { not: null } } as const;

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: SystemActivityService,
  ) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetIdFilter?: string,
    @Query('since') sinceRaw?: string,
    /**
     * ARCHIVAGE — vue par defaut = NON ARCHIVEES.
     *
     * `archivees=false` (defaut) : seules les lignes actives ; `true` : seulement les
     * archivees ; `toutes` : les deux. L'archivage n'efface RIEN — il retire de la vue
     * par defaut, et ce parametre est le seul moyen de le defaire cote lecture.
     */
    @Query('archivees') archiveesRaw?: string,
  ) {
    // V1.16 (audit residual) — fail-closed : un non-super sans fleetId ne voit RIEN.
    const scope = resolveTenantScope(req.user);
    if (scope.mode === 'DENY') {
      return {
        summary: {
          failing: 0,
          offline: 0,
          pending: 0,
          errorsLast24h: 0,
          errorsPrev24h: 0,
          criticalLastHour: 0,
          errorsSinceLastVisit: null,
          vueArchivage: 'actives' as const,
          errorsArchivees24h: 0,
        },
        failing: [],
        offline: [],
        pendingCommands: [],
        errors: { last24h: 0, criticalLastHour: 0, bySource: [], topMessages: [], recentCritical: [], recent: [] },
      };
    }
    // SUPER_ADMIN : filtre optionnel via ?fleetId= ; non-super : force sur sa flotte.
    const fleetIdScope = scope.mode === 'ALL' ? (fleetIdFilter ?? undefined) : scope.fleetId;
    // V1.18 — En vue globale (aucune flotte ciblée), on EXCLUT les trackers non
    // affectés à un véhicule (boîtiers en stock / pas encore posés) : un boîtier non
    // déployé n'est pas une alerte opérationnelle et polluait les sections « hors
    // ligne »/« FAILING ». Avec un fleetId ciblé, `vehicle.fleetId` exclut déjà les
    // non affectés (un tracker sans véhicule ne matche aucune flotte).
    const fleetClause = fleetIdScope
      ? { vehicle: { fleetId: fleetIdScope } }
      : { vehicleId: { not: null } };

    const now = Date.now();
    const offlineCutoff = new Date(now - OFFLINE_THRESHOLD_MS);
    const pendingCutoff = new Date(now - PENDING_THRESHOLD_MS);
    const errorCutoff = new Date(now - ERROR_WINDOW_MS);
    const errorPrevCutoff = new Date(now - 2 * ERROR_WINDOW_MS);
    const criticalCutoff = new Date(now - CRITICAL_WINDOW_MS);
    const sinceCutoff = sinceRaw ? new Date(sinceRaw) : null;

    // ARCHIVAGE — trois vues, une seule par defaut.
    const vueArchivage: 'actives' | 'archivees' | 'toutes' =
      archiveesRaw === 'true' ? 'archivees' : archiveesRaw === 'toutes' ? 'toutes' : 'actives';
    const clauseArchivage =
      vueArchivage === 'actives'
        ? { resolvedAt: null }
        : vueArchivage === 'archivees'
          ? { resolvedAt: { not: null } }
          : {};

    const [failingTrackers, offlineTrackers, pendingCommands, errorLogs24h, criticalCount, errorsPrev24h, errorsSince, archivees24h] = await Promise.all([
      this.prisma.tracker.findMany({
        where: { fixCommandFailing: true, ...fleetClause },
        include: { vehicle: { include: { fleet: true } } },
        take: 200,
      }),
      this.prisma.tracker.findMany({
        where: {
          status: 'OFFLINE',
          OR: [{ lastSeenAt: { lt: offlineCutoff } }, OFFLINE_NEVER_SEEN_CLAUSE],
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
          ...(fleetIdScope
            ? { tracker: { vehicle: { fleetId: fleetIdScope } } }
            : { tracker: { vehicleId: { not: null } } }),
        },
        include: { tracker: { include: { vehicle: { include: { fleet: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      // V1.14 — Erreurs applicatives (24h) pour le centre d'alertes.
      this.prisma.errorLog.findMany({
        where: { createdAt: { gte: errorCutoff }, ...clauseArchivage },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.prisma.errorLog.count({
        where: { level: 'CRITICAL', createdAt: { gte: criticalCutoff }, ...clauseArchivage },
      }),
      // Tendance : count erreurs 24h precedentes (pour comparaison).
      this.prisma.errorLog.count({
        where: { createdAt: { gte: errorPrevCutoff, lt: errorCutoff }, ...clauseArchivage },
      }),
      // Count depuis derniere visite (si fourni).
      sinceCutoff
        ? this.prisma.errorLog.count({ where: { createdAt: { gte: sinceCutoff }, ...clauseArchivage } })
        : Promise.resolve(null as number | null),
      // Combien de lignes sont MASQUEES par la vue actuelle : sans ce chiffre, un
      // ecran vide ne dit pas s'il n'y a rien ou si tout a ete archive.
      this.prisma.errorLog.count({
        where: { createdAt: { gte: errorCutoff }, resolvedAt: { not: null } },
      }),
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

    const mapError = (e: (typeof errorLogs24h)[number]) => ({
      id: e.id,
      level: e.level,
      source: e.source,
      message: e.message.split('\n')[0].slice(0, 300),
      stack: e.stack?.slice(0, 500) ?? null,
      imei: e.imei,
      userId: e.userId,
      context: e.context,
      createdAt: e.createdAt.toISOString(),
      resolvedAt: e.resolvedAt?.toISOString() ?? null,
      resolvedById: e.resolvedById,
      resolvedNote: e.resolvedNote,
    });

    // Dernières erreurs CRITICAL (10 max).
    const recentCritical = errorLogs24h.filter((e) => e.level === 'CRITICAL').slice(0, 10).map(mapError);

    // Dernières erreurs toutes catégories (15 max) — pour voir "chez qui" (user,
    // page, device dans `context`) y compris les erreurs frontend (level ERROR).
    const recent = errorLogs24h.slice(0, 15).map(mapError);

    return {
      summary: {
        failing: failingTrackers.length,
        offline: offlineTrackers.length,
        pending: pendingCommands.length,
        errorsLast24h: errorLogs24h.length,
        errorsPrev24h,
        criticalLastHour: criticalCount,
        errorsSinceLastVisit: errorsSince,
        vueArchivage,
        errorsArchivees24h: archivees24h,
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
        // TRK-048 — la cadence est une MESURE : sans trame valide récente, elle est un
        // vestige (FS-253-HR : « 1 s » affiché en émettant à 20 s pile). L'écran doit
        // rendre « non mesurable », jamais un chiffre faux.
        currentFixIntervalPerime: cadenceMesurePerimee(t),
        lastValidFrameAt: t.lastValidFrameAt?.toISOString() ?? null,
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
        recent,
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
   * V1.14 — Export markdown complet pour debug IA (Claude).
   * Inclut : erreurs applicatives (24h) + alertes trackers (failing, offline, pending).
   */
  @Get('errors/export')
  @Roles(UserRole.SUPER_ADMIN)
  async errorsExport() {
    const since = new Date(Date.now() - ERROR_WINDOW_MS);
    const offlineCut = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
    const pendingCut = new Date(Date.now() - PENDING_THRESHOLD_MS);

    const [errors, failingTrackers, offlineTrackers, pendingCommands] = await Promise.all([
      this.prisma.errorLog.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.tracker.findMany({
        where: { fixCommandFailing: true },
        include: { vehicle: { include: { fleet: true } } },
      }),
      this.prisma.tracker.findMany({
        where: { status: 'OFFLINE', OR: [{ lastSeenAt: { lt: offlineCut } }, OFFLINE_NEVER_SEEN_CLAUSE] },
        include: { vehicle: true },
        take: 50,
      }),
      this.prisma.trackerCommand.findMany({
        where: {
          status: { in: [TrackerCommandStatus.PENDING, TrackerCommandStatus.SENT] },
          createdAt: { lt: pendingCut },
          acknowledgedAt: null,
        },
        include: { tracker: { select: { imei: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const criticalCount = errors.filter((e) => e.level === 'CRITICAL').length;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const totalAlerts = failingTrackers.length + offlineTrackers.length + pendingCommands.length;

    let md = `# Rapport Vizyo Tracky — Debug IA\n`;
    md += `Genere le : ${now} UTC\n\n`;
    md += `## Vue d'ensemble\n`;
    md += `- Erreurs applicatives (24h) : ${errors.length} (dont ${criticalCount} CRITICAL)\n`;
    md += `- Trackers FAILING : ${failingTrackers.length}\n`;
    md += `- Trackers OFFLINE > 1h : ${offlineTrackers.length}\n`;
    md += `- Commandes en attente > 10min : ${pendingCommands.length}\n\n`;

    // Section Trackers FAILING
    if (failingTrackers.length > 0) {
      md += `## Trackers FAILING\n`;
      md += `| Plaque | IMEI | Echecs | Desired (s) | Reel (s) | Status | Dernier vu |\n`;
      md += `|--------|------|--------|-------------|----------|--------|------------|\n`;
      for (const t of failingTrackers) {
        md += `| ${t.vehicle?.plate ?? '—'} | ${t.imei} | ${t.fixCommandFailureCount} | ${t.desiredFixIntervalS} | ${t.currentFixIntervalS ?? '?'} | ${t.status} | ${t.lastSeenAt?.toISOString().slice(0, 19).replace('T', ' ') ?? 'jamais'} |\n`;
      }
      md += `\n`;
    }

    // Section Commandes pending
    if (pendingCommands.length > 0) {
      md += `## Commandes en attente (> 10 min)\n`;
      md += `| IMEI | Template | Status | Cree le | Raison |\n`;
      md += `|------|----------|--------|---------|--------|\n`;
      for (const c of pendingCommands) {
        md += `| ${c.tracker.imei} | ${c.templateId} | ${c.status} | ${c.createdAt.toISOString().slice(0, 19).replace('T', ' ')} | ${c.outcomeReason ?? '—'} |\n`;
      }
      md += `\n`;
    }

    // Section Erreurs applicatives
    if (errors.length > 0) {
      // Résumé par source.
      const sourceMap = new Map<string, { count: number; lastAt: string }>();
      for (const e of errors) {
        const iso = e.createdAt.toISOString();
        const existing = sourceMap.get(e.source);
        if (!existing) {
          sourceMap.set(e.source, { count: 1, lastAt: iso });
        } else {
          existing.count++;
          // #32 — colonne "Derniere" = la PLUS RECENTE : lastAt n'etait jamais mis a
          // jour (restait le first-seen). Les ISO meme format se comparent chrono.
          if (iso > existing.lastAt) existing.lastAt = iso;
        }
      }

      md += `## Erreurs applicatives par source (24h)\n`;
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
    }

    return {
      markdown: md,
      errorCount: errors.length + totalAlerts,
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
      if (fleetId !== req.user.fleetId) throw new ForbiddenException('Accès refusé');
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

  // ═══════════════════════════════════════════════════════════════════════════
  // ARCHIVAGE REVERSIBLE DU CENTRE D'ALERTE (2026-08-22)
  //
  // « Clear » ne veut PAS dire supprimer. Une ligne archivee reste en base, sort de
  // la vue par defaut, et se rouvre. Trois raisons, toutes payees :
  //
  //  1. La consigne du proprietaire depuis l'origine : une erreur reste visible tant
  //     qu'elle n'est pas corrigee ET verifiee.
  //  2. TRK-035 : des lignes disparaissent deja hors application (66 ecrites, 73
  //     effacees en 20,7 h le 22/08). Un archivage qui SUPPRIME reproduirait
  //     volontairement le defaut qu'on cherche a attribuer, et rendrait la sonde de
  //     recensement inexploitable — elle ne saurait plus distinguer nos archivages
  //     des suppressions de l'intrus.
  //  3. Reversibilite : archiver a tort est le cas normal, pas l'exception. Une
  //     archive qu'on ne peut pas rouvrir est une suppression avec un delai.
  //
  // SUPER_ADMIN uniquement : `error_logs` est GLOBAL (aucune colonne de flotte), donc
  // un FLEET_ADMIN qui archiverait masquerait des lignes qui ne sont pas les siennes.
  // Il les voit — c'est deja le cas aujourd'hui — mais il ne les classe pas.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Archiver UNE ligne : elle sort de la vue par defaut, elle reste en base. */
  @Post('errors/:id/archiver')
  @Roles(UserRole.SUPER_ADMIN)
  async archiverErreur(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { note?: string },
  ) {
    const ligne = await this.prisma.errorLog.findUnique({ where: { id } });
    if (!ligne) throw new NotFoundException('Ligne introuvable');
    // Deja archivee : on ne re-date PAS. Sinon un double clic effacerait qui a
    // archive en premier, et l'heure a laquelle la ligne a cesse d'etre lue.
    if (ligne.resolvedAt) {
      return { ok: true, dejaArchivee: true, resolvedAt: ligne.resolvedAt.toISOString() };
    }

    const maj = await this.prisma.errorLog.update({
      where: { id },
      data: {
        resolvedAt: new Date(),
        resolvedById: req.user.id,
        resolvedNote: body?.note?.slice(0, 2000) ?? null,
      },
    });

    this.activity.record({
      category: 'ALERT',
      action: 'error_log_archive',
      status: 'SUCCESS',
      actor: req.user.email ?? req.user.id,
      triggeredByUserId: req.user.id,
      target: `${ligne.source} — ${ligne.message.slice(0, 120)}`,
      detail: body?.note ?? null,
      meta: { errorLogId: id, level: ligne.level, source: ligne.source, createdAt: ligne.createdAt.toISOString() },
    });

    return { ok: true, resolvedAt: maj.resolvedAt?.toISOString() ?? null };
  }

  /** Rouvrir : `resolvedAt` repasse a null, la ligne revient dans la vue par defaut. */
  @Post('errors/:id/rouvrir')
  @Roles(UserRole.SUPER_ADMIN)
  async rouvrirErreur(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const ligne = await this.prisma.errorLog.findUnique({ where: { id } });
    if (!ligne) throw new NotFoundException('Ligne introuvable');
    if (!ligne.resolvedAt) return { ok: true, dejaActive: true };

    await this.prisma.errorLog.update({
      where: { id },
      // `resolvedNote` est CONSERVEE : elle dit pourquoi on avait cru pouvoir classer,
      // et c'est precisement ce qu'on veut relire quand la ligne revient.
      data: { resolvedAt: null, resolvedById: null },
    });

    this.activity.record({
      category: 'ALERT',
      action: 'error_log_reouverture',
      status: 'SUCCESS',
      actor: req.user.email ?? req.user.id,
      triggeredByUserId: req.user.id,
      target: `${ligne.source} — ${ligne.message.slice(0, 120)}`,
      detail: ligne.resolvedNote,
      meta: { errorLogId: id, archiveeLe: ligne.resolvedAt.toISOString() },
    });

    return { ok: true };
  }

  /**
   * Archivage en masse — le geste de fin de journee.
   *
   * ⚠️ `avant` est OBLIGATOIRE, et c'est le coeur de la correction : il porte l'instant
   * ou l'operateur a regarde l'ecran. Sans lui, une ligne ecrite entre l'affichage et
   * le clic serait archivee SANS AVOIR ETE LUE — exactement l'erreur qu'un archivage
   * de fin de journee est cense eviter.
   */
  @Post('errors/archiver-en-masse')
  @Roles(UserRole.SUPER_ADMIN)
  async archiverEnMasse(
    @Req() req: AuthenticatedRequest,
    @Body() body: { avant?: string; note?: string; source?: string; level?: string },
  ) {
    const avant = body?.avant ? new Date(body.avant) : null;
    if (!avant || Number.isNaN(avant.getTime())) {
      throw new BadRequestException(
        "`avant` est obligatoire : c'est l'instant où l'écran a été lu. Sans lui, une erreur arrivée entre l'affichage et le clic serait archivée sans avoir été vue.",
      );
    }
    if (avant.getTime() > Date.now() + 60_000) {
      throw new BadRequestException('`avant` est dans le futur : refus.');
    }

    const where = {
      resolvedAt: null,
      createdAt: { lte: avant },
      ...(body?.source ? { source: body.source } : {}),
      ...(body?.level ? { level: body.level } : {}),
    };

    const combien = await this.prisma.errorLog.count({ where });
    if (combien > ARCHIVAGE_MASSE_MAX) {
      throw new BadRequestException(
        `${combien} lignes correspondent, au-dela du plafond de ${ARCHIVAGE_MASSE_MAX}. Affinez par source ou par niveau : un archivage en masse doit rester relisable.`,
      );
    }
    if (combien === 0) return { ok: true, archivees: 0 };

    const { count } = await this.prisma.errorLog.updateMany({
      where,
      data: {
        resolvedAt: new Date(),
        resolvedById: req.user.id,
        resolvedNote: body?.note?.slice(0, 2000) ?? null,
      },
    });

    this.activity.record({
      category: 'ALERT',
      action: 'error_log_archive_masse',
      status: 'SUCCESS',
      actor: req.user.email ?? req.user.id,
      triggeredByUserId: req.user.id,
      target: `${count} ligne(s) du centre d'alerte`,
      detail: body?.note ?? `Archivage de tout ce qui precede ${avant.toISOString()}`,
      meta: { count, avant: avant.toISOString(), source: body?.source ?? null, level: body?.level ?? null },
    });

    return { ok: true, archivees: count };
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
      if (tracker.vehicle?.fleetId !== req.user.fleetId) throw new ForbiddenException('Accès refusé');
    }
    await this.prisma.tracker.update({
      where: { id: trackerId },
      data: { fixCommandFailing: false, fixCommandFailureCount: 0 },
    });
    return { ok: true };
  }
}
