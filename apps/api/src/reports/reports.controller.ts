import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
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
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { GenerateExcelDto } from './dto/generate-excel.dto';
import { GeneratePdfDto } from './dto/generate-pdf.dto';
import { ReportCsvService } from './report-csv.service';
import { ReportExcelService } from './report-excel.service';
import { ReportPdfService } from './report-pdf.service';
import { ReportsStatsService } from './reports-stats.service';
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
   * 🔒 Sprint 5 — borne de perimetre transmise a chaque service de rapport :
   * 'ALL' pour les admins, sinon la liste des vehicules accessibles de l'user.
   * Memoise par requete (cf. VehicleAccessService).
   */
  private accessibleVehicleIds(req: AuthenticatedRequest): Promise<string[] | 'ALL'> {
    return this.vehicleAccess.getAccessibleVehicleIds(req.user);
  }

  @Get('stats')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_view')
  async statsJson(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetIdQ: string | undefined,
    @Query('from') fromRaw: string,
    @Query('to') toRaw: string,
  ) {
    const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw, toRaw);
    const accessibleVehicleIds = await this.accessibleVehicleIds(req);
    return this.stats.compute(fleetId, from, to, { role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds });
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
    const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw, toRaw);
    const accessibleVehicleIds = await this.accessibleVehicleIds(req);
    const report = await this.stats.compute(fleetId, from, to, { role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds });
    const buffer = await this.pdf.generate(report);
    const filename = `tracky-rapport-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
    this.recordExport(req, 'export_pdf', filename, fleetId, { from: fromRaw, to: toRaw });
  }

  /**
   * Variante configurable du PDF — permet de filtrer par vehicleIds et de
   * choisir les sections embarquees. Le GET historique reste expose pour
   * compat. Les rapports sont generes a la volee (pas de cache) — l'utilisateur
   * sent immediatement le scope qu'il a configure.
   */
  @Post('pdf')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_export')
  async pdfDownloadConfigured(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Body() body: GeneratePdfDto,
  ): Promise<void> {
    const { from, to, fleetId } = await this.parseRange(req, body.fleetId, body.from, body.to, body.vehicleIds);

    const vehicleIds = (body.vehicleIds ?? []).filter((id) => !!id);
    const scopeLabel = vehicleIds.length > 0
      ? `${vehicleIds.length} vehicule${vehicleIds.length > 1 ? 's' : ''} selectionne${vehicleIds.length > 1 ? 's' : ''}`
      : undefined;

    const accessibleVehicleIds = await this.accessibleVehicleIds(req);
    const report = await this.stats.compute(
      fleetId,
      from,
      to,
      { role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds },
      { vehicleIds, maxRecentTrips: body.maxTrips },
    );

    const buffer = await this.pdf.generate(report, {
      sections: body.sections,
      maxTrips: body.maxTrips,
      topN: body.topN,
      scopeLabel,
    });

    const filename = `tracky-rapport-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
  ): Promise<void> {
    const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw, toRaw);
    const ids = await this.accessibleVehicleIds(req);
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
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.body);
    this.recordExport(req, `export_csv_${type}`, result.filename, fleetId, { from: fromRaw, to: toRaw });
  }

  /**
   * Sprint 5 — Export Excel « soigné » PAR VÉHICULE (exceljs).
   * Body { vehicleId, from, to }. Le périmètre utilisateur est vérifié dans le
   * service (vehicleId doit être dans le périmètre accessible + la flotte de
   * l'appelant) → 403 sinon. Même périmètre d'auth que les autres exports.
   */
  @Post('excel')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_export')
  async excelDownload(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Body() body: GenerateExcelDto,
  ): Promise<void> {
    const from = new Date(body.from);
    const to = new Date(body.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from et to doivent être des dates ISO valides');
    }
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('from doit etre strictement avant to');
    }
    const { buffer, filename } = await this.excel.generate(body.vehicleId, from, to, req.user);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
    this.recordExport(req, 'export_excel', filename, null, {
      vehicleId: body.vehicleId, from: body.from, to: body.to,
    });
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
    const { html, filename } = await this.speedReport.generate(tripId, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
    this.recordExport(req, 'export_speed', filename, null, { tripId });
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
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
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
