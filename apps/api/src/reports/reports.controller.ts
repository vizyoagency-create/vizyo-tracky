import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { parisDayKey, parisDayStart } from '../common/utils/datetime';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { GenerateExcelDto } from './dto/generate-excel.dto';
import { GeneratePdfDto } from './dto/generate-pdf.dto';
import { SetReportScheduleDto } from './dto/set-report-schedule.dto';
import { ReportCsvService } from './report-csv.service';
import { ReportScheduleService } from './report-schedule.service';
import { ReportExcelService } from './report-excel.service';
import { ReportPdfService } from './report-pdf.service';
import { ReportsStatsService } from './reports-stats.service';
import { enTeteTelechargement } from '../common/utils/telechargement';
import { SpeedReportService } from './speed-report.service';

/**
 * V1.5 (Sprint L) — Endpoints de rapports.
 *
 *  - GET /api/reports/stats?fleetId=&from=&to=    : KPIs JSON
 *  - GET /api/reports/pdf?fleetId=&from=&to=      : binaire PDF
 *  - GET /api/reports/csv?type=positions|trips|alerts|commands&fleetId=&from=&to=
 *
 * Tenant check : un FLEET_ADMIN/MANAGER ne peut acceder qu'a sa flotte.
 * Un SUPER_ADMIN peut specifier n'importe quel fleetId.
 */
@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class ReportsController {
  constructor(
    private readonly stats: ReportsStatsService,
    private readonly pdf: ReportPdfService,
    private readonly csv: ReportCsvService,
    private readonly excel: ReportExcelService,
    private readonly speedReport: SpeedReportService,
    private readonly schedule: ReportScheduleService,
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /**
   * Journal Système — un export = une exfiltration de données (positions GPS
   * complètes) déclenchable par un simple VIEWER : chaque téléchargement est
   * tracé avec son périmètre. Fire-and-forget, ne casse jamais le download.
   */
  private recordExport(
    req: AuthenticatedRequest,
    action: string,
    filename: string,
    fleetId: string | null,
    meta?: Record<string, unknown>,
  ): void {
    const u = req.user;
    this.systemActivity.record({
      category: 'EXPORT',
      action,
      status: 'SUCCESS',
      actor: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'utilisateur',
      target: filename,
      fleetId: fleetId ?? u.fleetId ?? null,
      triggeredByUserId: u.id,
      meta,
    });
  }

  /**
   * Un export qui ÉCHOUE ne laissait AUCUNE trace : le client voyait un bandeau rouge, et
   * l'espace admin ne voyait rien du tout. Une société incapable de sortir ses rapports
   * depuis trois jours était donc invisible — seuls les téléchargements RÉUSSIS étaient
   * journalisés. Même journal, statut FAILURE, avec la raison.
   *
   * Ne change rien au comportement HTTP : l'erreur est relancée telle quelle.
   */
  private async traceEchec<T>(
    req: AuthenticatedRequest,
    action: string,
    fleetId: string | null,
    meta: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const raison = err instanceof Error ? err.message : String(err);
      const u = req.user;
      this.systemActivity.record({
        category: 'EXPORT',
        action,
        status: 'FAILURE',
        actor: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'utilisateur',
        target: raison.slice(0, 200),
        fleetId: fleetId ?? u.fleetId ?? null,
        triggeredByUserId: u.id,
        meta: { ...meta, erreur: raison },
      });
      throw err;
    }
  }

  /**
   * 🔒 Sprint 5 — borne de perimetre transmise a chaque service de rapport :
   * 'ALL' pour les admins, sinon la liste des vehicules accessibles de l'user.
   * Memoise par requete (cf. VehicleAccessService).
   */
  private accessibleVehicleIds(req: AuthenticatedRequest): Promise<string[] | 'ALL'> {
    return this.vehicleAccess.getAccessibleVehicleIds(req.user);
  }

  /**
   * Dates du nom de fichier, en jours civils de Paris et fin INCLUSE : la borne `to` de
   * l'API est le lendemain minuit, et « rapport-2026-08-03_2026-09-03 » faisait croire
   * que le 3 septembre était dedans.
   */
  private fileDates(from: Date, to: Date): string {
    return `${parisDayKey(from)}_${parisDayKey(new Date(to.getTime() - 1))}`;
  }

  @Get('stats')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_view')
  async statsJson(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetIdQ: string | undefined,
    @Query('from') fromRaw: string,
    @Query('to') toRaw: string,
    @Query('vehicleIds') vehicleIdsQ: string | undefined,
    @Query('topN') topNQ: string | undefined,
  ) {
    const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw, toRaw);
    const accessibleVehicleIds = await this.accessibleVehicleIds(req);
    /**
     * ── DEUX PARAMÈTRES QUE LE SERVICE ACCEPTAIT DÉJÀ, ET QUE LA ROUTE TAISAIT ─────────
     *
     * `compute` sait restreindre à des véhicules et régler la profondeur du classement
     * depuis toujours ; seule cette route ne le laissait pas dire. L'écran Rapports, qui
     * filtre par véhicule et par groupe, ne pouvait donc pas demander SON périmètre — et
     * c'est la raison pour laquelle il additionnait lui-même les trajets de la page chargée,
     * en affichant un récapitulatif faux dès l'ouverture.
     *
     * ⚠️ Le périmètre demandé ne desserre RIEN : `compute` l'intersecte avec les véhicules
     * réellement accessibles à l'appelant. Demander un véhicule d'une autre société ne le
     * rend pas visible, il disparaît simplement du résultat.
     */
    const vehicleIds = (vehicleIdsQ ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return this.stats.compute(fleetId, from, to, { role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds }, {
      vehicleIds: vehicleIds.length > 0 ? vehicleIds : undefined,
      topN: topNQ ? Number(topNQ) : undefined,
    });
  }

  @Get('pdf')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_export')
  async pdfDownload(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('fleetId') fleetIdQ: string | undefined,
    @Query('from') fromRaw: string,
    @Query('to') toRaw: string,
  ): Promise<void> {
    await this.traceEchec(req, 'export_pdf', fleetIdQ ?? null, { from: fromRaw, to: toRaw }, async () => {
      const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw, toRaw);
      const accessibleVehicleIds = await this.accessibleVehicleIds(req);
      const report = await this.stats.compute(fleetId, from, to, { role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds });
      const buffer = await this.pdf.generate(report);
      const filename = `tracky-rapport-${this.fileDates(from, to)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', enTeteTelechargement(filename));
      res.send(buffer);
      this.recordExport(req, 'export_pdf', filename, fleetId, { from: fromRaw, to: toRaw });
    });
  }

  /**
   * Variante configurable du PDF — permet de filtrer par vehicleIds et de
   * choisir les sections embarquees. Le GET historique reste expose pour
   * compat. Les rapports sont generes a la volee (pas de cache) — l'utilisateur
   * sent immediatement le scope qu'il a configure.
   */
  @Post('pdf')
  @HttpCode(200)
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_export')
  async pdfDownloadConfigured(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Body() body: GeneratePdfDto,
  ): Promise<void> {
    await this.traceEchec(req, 'export_pdf', body.fleetId ?? null, { from: body.from, to: body.to, vehicleIds: body.vehicleIds?.length || undefined }, () =>
      this.genererPdfConfigure(req, res, body));
  }

  /** Corps du POST /pdf — extrait pour que l'échec comme la réussite soient journalisés. */
  private async genererPdfConfigure(
    req: AuthenticatedRequest,
    res: Response,
    body: GeneratePdfDto,
  ): Promise<void> {
    const { from, to, fleetId } = await this.parseRange(req, body.fleetId, body.from, body.to, body.vehicleIds);

    const vehicleIds = (body.vehicleIds ?? []).filter((id) => !!id);

    // Un rapport sur UN véhicule s'appelait « Rapport de flotte » et n'affichait pas la
    // plaque ; jusqu'à cinq véhicules, les plaques sont listées ; au-delà, un compte.
    let scopeLabel: string | undefined;
    let title: string | undefined;
    let fileScope = '';
    if (vehicleIds.length > 0) {
      const plates = await this.prisma.vehicle.findMany({
        where: { id: { in: vehicleIds } },
        select: { plate: true, brand: true, model: true },
        orderBy: { plate: 'asc' },
      });
      if (plates.length === 1) {
        const v = plates[0]!;
        title = 'Rapport véhicule';
        scopeLabel = [v.plate, [v.brand, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' — ');
        fileScope = `${v.plate.replace(/[^A-Za-z0-9-]+/g, '-')}-`;
      } else if (plates.length <= 5) {
        scopeLabel = `${plates.length} véhicules : ${plates.map((v) => v.plate).join(', ')}`;
      } else {
        scopeLabel = `${plates.length} véhicules sélectionnés`;
      }
    }

    const accessibleVehicleIds = await this.accessibleVehicleIds(req);
    const report = await this.stats.compute(
      fleetId,
      from,
      to,
      { role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds },
      { vehicleIds, maxRecentTrips: body.maxTrips, topN: body.topN },
    );

    const buffer = await this.pdf.generate(report, {
      sections: body.sections,
      maxTrips: body.maxTrips,
      topN: body.topN,
      scopeLabel,
      title,
    });

    const filename = `tracky-rapport-${fileScope}${this.fileDates(from, to)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', enTeteTelechargement(filename));
    res.send(buffer);
    this.recordExport(req, 'export_pdf', filename, fleetId, {
      from: body.from, to: body.to, vehicleIds: vehicleIds.length || undefined,
    });
  }

  @Get('csv')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_export')
  async csvDownload(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('type') type: string,
    @Query('fleetId') fleetIdQ: string | undefined,
    @Query('from') fromRaw: string,
    @Query('to') toRaw: string,
    @Query('vehicleIds') vehicleIdsRaw?: string,
  ): Promise<void> {
    await this.traceEchec(req, `export_csv_${type}`, fleetIdQ ?? null, { from: fromRaw, to: toRaw }, async () => {
      const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw, toRaw);
      // Périmètre de l'ÉCRAN (véhicule ou groupe sélectionné), borné aux accès de l'appelant :
      // un CSV « trajets » demandé depuis un rapport filtré sur un véhicule exportait toute la
      // flotte. `resolveReportVehicleScope` rejette (403) toute demande hors périmètre.
      const wanted = (vehicleIdsRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const ids = resolveReportVehicleScope(await this.accessibleVehicleIds(req), wanted);
      let result;
      switch (type) {
        case 'positions': result = await this.csv.positions(fleetId, from, to, ids); break;
        case 'trips': result = await this.csv.trips(fleetId, from, to, ids); break;
        case 'alerts': result = await this.csv.alerts(fleetId, from, to, ids); break;
        case 'commands': result = await this.csv.commands(fleetId, from, to, ids); break;
        default:
          throw new BadRequestException('type doit valoir positions / trips / alerts / commands');
      }
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', enTeteTelechargement(result.filename));
      res.send(result.body);
      this.recordExport(req, `export_csv_${type}`, result.filename, fleetId, { from: fromRaw, to: toRaw, vehicules: ids === 'ALL' ? undefined : ids.length });
    });
  }

  /**
   * Sprint 5 — Export Excel « soigné » PAR VÉHICULE (exceljs).
   * Body { vehicleId, from, to }. Le périmètre utilisateur est vérifié dans le
   * service (vehicleId doit être dans le périmètre accessible + la flotte de
   * l'appelant) → 403 sinon. Même périmètre d'auth que les autres exports.
   */
  @Post('excel')
  @HttpCode(200)
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_export')
  async excelDownload(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Body() body: GenerateExcelDto,
  ): Promise<void> {
    await this.traceEchec(req, 'export_excel', null, { vehicleId: body.vehicleId, from: body.from, to: body.to }, async () => {
      // Jours civils de Paris, comme le PDF et les listes (cf. parisDayStart).
      const from = parisDayStart(body.from);
      const to = parisDayStart(body.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new BadRequestException('from et to doivent être des dates ISO valides');
      }
      if (from.getTime() >= to.getTime()) {
        throw new BadRequestException('from doit etre strictement avant to');
      }
      /**
       * ── UN VÉHICULE, OU TOUT UN PÉRIMÈTRE ────────────────────────────────────────
       *
       * `vehicleId` absent = classeur de société (éventuellement borné à un groupe), avec
       * une feuille de synthèse par véhicule en tête. Jusqu'ici, obtenir le mois d'un parc
       * demandait quarante exports recollés à la main.
       *
       * ⚠️ La flotte retenue est celle du VÉHICULE (ou celle demandée), pas celle de
       * l'appelant : un super-administrateur exporte pour autrui. Le service, lui,
       * intersecte toujours avec les véhicules réellement accessibles.
       */
      const veh = body.vehicleId
        ? await this.prisma.vehicle.findUnique({ where: { id: body.vehicleId }, select: { fleetId: true } })
        : null;
      let fleetIdCible = veh?.fleetId ?? body.fleetId ?? req.user.fleetId ?? null;
      if (!body.vehicleId && !fleetIdCible) {
        // Super-administrateur sans société : on refuse plutôt que d'en choisir une au
        // hasard — un classeur portant le nom d'une société qu'on n'a pas demandée serait
        // pire qu'une erreur, il aurait l'air juste.
        throw new BadRequestException(
          'Précisez une société (fleetId) ou un véhicule : un classeur de parc doit désigner son périmètre.',
        );
      }
      const { buffer, filename } = body.vehicleId
        ? await this.excel.generate(body.vehicleId, from, to, req.user)
        : await this.excel.generateScope({ fleetId: fleetIdCible!, groupId: body.groupId }, from, to, req.user);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', enTeteTelechargement(filename));
      res.send(buffer);
      this.recordExport(req, 'export_excel', filename, fleetIdCible, {
        vehicleId: body.vehicleId, groupId: body.groupId, from: body.from, to: body.to,
      });
    });
  }

  // ─── Rapport hebdomadaire : réglage par société + journal des envois ───────────────

  /** Réglage effectif (valeurs par défaut si rien n'est enregistré) + prochaine échéance. */
  @Get('schedule')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('reports_view')
  getSchedule(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.schedule.get(req.user, fleetId);
  }

  /**
   * ⚠️ FLEET_MANAGER est ici volontairement : régler le rapport hebdomadaire de SA société
   * relève de la gestion de flotte, pas de l'administration de la plateforme. Le droit
   * `reports_export` reste exigé — un gestionnaire à qui on l'a retiré reçoit un 403, et
   * l'écran ne lui montre pas les commandes. Le périmètre société, lui, est verrouillé dans
   * `resolveFleetId` : un non-super-admin ne peut régler que sa propre société.
   */
  /**
   * Vue d'ensemble : le réglage hebdomadaire de TOUTES les sociétés, en une lecture.
   *
   * ⚠️ Déclarée AVANT `PUT /schedule` et les routes paramétrées — l'ordre des routes compte
   * dans Nest, et `schedule/overview` doit être reconnu comme un chemin littéral.
   */
  @Get('schedule/overview')
  @Roles(UserRole.SUPER_ADMIN)
  @RequirePermissions('reports_view')
  scheduleOverview(@Req() req: AuthenticatedRequest) {
    return this.schedule.listAll(req.user);
  }

  @Put('schedule')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('reports_export')
  async setSchedule(
    @Req() req: AuthenticatedRequest,
    @Body() body: SetReportScheduleDto,
    @Query('fleetId') fleetId?: string,
  ) {
    const dto = await this.schedule.set(req.user, body, fleetId);
    this.systemActivity.record({
      category: 'EXPORT',
      action: 'weekly_report_settings',
      status: 'SUCCESS',
      actor: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email || 'utilisateur',
      target: dto.fleetName,
      fleetId: dto.fleetId,
      triggeredByUserId: req.user.id,
      meta: { enabled: dto.enabled, weekday: dto.weekday, hour: dto.hour, recipients: dto.recipients.length, sections: dto.sections, vehicles: dto.vehicleIds.length },
    });
    return dto;
  }

  /** Envoi immédiat des 7 derniers jours révolus — journalisé comme un passage manuel. */
  @Post('schedule/send-now')
  @HttpCode(200)
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('reports_export')
  async sendScheduleNow(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    const dispatch = await this.schedule.sendNow(req.user, fleetId);
    this.systemActivity.record({
      category: 'EXPORT',
      action: 'weekly_report_send_now',
      status: dispatch.status === 'FAILED' ? 'FAILURE' : 'SUCCESS',
      actor: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email || 'utilisateur',
      target: dispatch.fleetName,
      fleetId: dispatch.fleetId,
      triggeredByUserId: req.user.id,
      meta: { status: dispatch.status, recipients: dispatch.recipients.length, tripsCount: dispatch.tripsCount, pdfBytes: dispatch.pdfBytes, error: dispatch.error ?? undefined },
    });
    return { dispatch };
  }

  /** Journal des envois (société courante ; toutes les sociétés pour un super-admin sans fleetId). */
  @Get('schedule/dispatches')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('reports_view')
  listScheduleDispatches(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetId?: string,
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit);
    return this.schedule.listDispatches(req.user, fleetId, Number.isFinite(n) && n > 0 ? n : 20);
  }

  /**
   * Rapport d'analyse de vitesse pour un trajet — HTML telechargeable.
   * Reserve aux FLEET_ADMIN et SUPER_ADMIN. Le tenant check est dans le
   * service (fleetId compare au trajet). Genere dynamiquement le rapport
   * a partir des positions GPS du trajet — generique, pas specifique a
   * une flotte.
   */
  @Get('speed-analysis/:tripId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('reports_export')
  async speedAnalysis(
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.traceEchec(req, 'export_speed', null, { tripId }, async () => {
      const { html, filename } = await this.speedReport.generate(tripId, {
        userId: req.user.id,
        role: req.user.role,
        fleetId: req.user.fleetId,
      });
      // La flotte du TRAJET : le journal était écrit sans flotte, donc invisible au filtre
      // par société de l'espace admin (un super-admin exporte pour n'importe quelle société).
      const trip = await this.prisma.trip.findUnique({
        where: { id: tripId },
        select: { vehicle: { select: { fleetId: true } } },
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', enTeteTelechargement(filename));
      res.send(html);
      this.recordExport(req, 'export_speed', filename, trip?.vehicle?.fleetId ?? null, { tripId });
    });
  }

  private async parseRange(
    req: AuthenticatedRequest,
    fleetIdQ: string | undefined,
    fromRaw: string,
    toRaw: string,
    vehicleIdsHint?: string[],
  ): Promise<{ from: Date; to: Date; fleetId: string }> {
    if (!fromRaw || !toRaw) {
      throw new BadRequestException('from et to (ISO date) requis');
    }
    // Jours civils Europe/Paris (« 2026-08-03 » = minuit à Paris), comme les listes et les
    // agrégats de trajets : un PDF « du 3 au 9 » doit contenir exactement les trajets que
    // l'écran affiche pour ces jours-là. Un ISO complet (avec heure) reste lu tel quel.
    const from = parisDayStart(fromRaw);
    const to = parisDayStart(toRaw);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from et to doivent être des dates ISO valides');
    }
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('from doit etre strictement avant to');
    }
    let fleetId = req.user.role === UserRole.SUPER_ADMIN
      ? (fleetIdQ ?? req.user.fleetId ?? '')
      : (req.user.fleetId ?? '');
    if (!fleetId && req.user.role === UserRole.SUPER_ADMIN) {
      // Super-admin sans flotte explicite : si des véhicules précis sont
      // demandés (ex. export depuis une fiche véhicule), dériver la flotte de
      // CES véhicules — sinon on retombait sur une flotte arbitraire (la plus
      // ancienne), d'où le 400 « vehicleIds n'appartiennent pas a la flotte
      // demandee » dès que le véhicule vivait dans une autre flotte.
      const hintId = (vehicleIdsHint ?? []).find((id) => !!id);
      if (hintId) {
        const v = await this.prisma.vehicle.findUnique({ where: { id: hintId }, select: { fleetId: true } });
        if (v?.fleetId) fleetId = v.fleetId;
      }
      if (!fleetId) {
        const firstFleet = await this.prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
        if (firstFleet) fleetId = firstFleet.id;
      }
    }
    if (!fleetId) {
      throw new BadRequestException('fleetId requis');
    }
    return { from, to, fleetId };
  }
}
