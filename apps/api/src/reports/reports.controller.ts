import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { GeneratePdfDto } from './dto/generate-pdf.dto';
import { ReportCsvService } from './report-csv.service';
import { ReportPdfService } from './report-pdf.service';
import { ReportsStatsService } from './reports-stats.service';

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
    private readonly prisma: PrismaService,
  ) {}

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
    return this.stats.compute(fleetId, from, to, { role: req.user.role, fleetId: req.user.fleetId });
  }

  @Get('pdf')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_view')
  async pdfDownload(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('fleetId') fleetIdQ: string | undefined,
    @Query('from') fromRaw: string,
    @Query('to') toRaw: string,
  ): Promise<void> {
    const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw, toRaw);
    const report = await this.stats.compute(fleetId, from, to, { role: req.user.role, fleetId: req.user.fleetId });
    const buffer = await this.pdf.generate(report);
    const filename = `tracky-rapport-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /**
   * Variante configurable du PDF — permet de filtrer par vehicleIds et de
   * choisir les sections embarquees. Le GET historique reste expose pour
   * compat. Les rapports sont generes a la volee (pas de cache) — l'utilisateur
   * sent immediatement le scope qu'il a configure.
   */
  @Post('pdf')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_view')
  async pdfDownloadConfigured(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Body() body: GeneratePdfDto,
  ): Promise<void> {
    const { from, to, fleetId } = await this.parseRange(req, body.fleetId, body.from, body.to);

    const vehicleIds = (body.vehicleIds ?? []).filter((id) => !!id);
    const scopeLabel = vehicleIds.length > 0
      ? `${vehicleIds.length} vehicule${vehicleIds.length > 1 ? 's' : ''} selectionne${vehicleIds.length > 1 ? 's' : ''}`
      : undefined;

    const report = await this.stats.compute(
      fleetId,
      from,
      to,
      { role: req.user.role, fleetId: req.user.fleetId },
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
  }

  @Get('csv')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_view')
  async csvDownload(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('type') type: string,
    @Query('fleetId') fleetIdQ: string | undefined,
    @Query('from') fromRaw: string,
    @Query('to') toRaw: string,
  ): Promise<void> {
    const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw, toRaw);
    let result;
    switch (type) {
      case 'positions': result = await this.csv.positions(fleetId, from, to); break;
      case 'trips': result = await this.csv.trips(fleetId, from, to); break;
      case 'alerts': result = await this.csv.alerts(fleetId, from, to); break;
      case 'commands': result = await this.csv.commands(fleetId, from, to); break;
      default:
        throw new BadRequestException('type doit valoir positions / trips / alerts / commands');
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.body);
  }

  private async parseRange(
    req: AuthenticatedRequest,
    fleetIdQ: string | undefined,
    fromRaw: string,
    toRaw: string,
  ): Promise<{ from: Date; to: Date; fleetId: string }> {
    if (!fromRaw || !toRaw) {
      throw new BadRequestException('from et to (ISO date) requis');
    }
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from et to doivent etre des dates ISO valides');
    }
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('from doit etre strictement avant to');
    }
    let fleetId = req.user.role === UserRole.SUPER_ADMIN
      ? (fleetIdQ ?? req.user.fleetId ?? '')
      : (req.user.fleetId ?? '');
    if (!fleetId && req.user.role === UserRole.SUPER_ADMIN) {
      const firstFleet = await this.prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
      if (firstFleet) fleetId = firstFleet.id;
    }
    if (!fleetId) {
      throw new BadRequestException('fleetId requis');
    }
    return { from, to, fleetId };
  }
}
