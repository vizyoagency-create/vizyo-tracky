import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AiProviderId, DrivingScoreDetailDto, DrivingScoreScope, DrivingScoresDto, FuelFillUpDto, FuelStationMapPointDto, SetTripAutomationSettingsDto, TripAnalysisDto, TripAutomationRunStats, TripAutomationSettingsDto, TripNarrativeCompareDto, UpsertFuelFillUpDto, VehicleFuelModelDto, VehicleFuelReportDto } from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DrivingScoreService } from './driving-score.service';
import { FuelCalibrationService } from './fuel-calibration.service';
import { FuelReportService } from './fuel-report.service';
import { TripAnalysisLlmService } from './trip-analysis-llm.service';
import { TripAnalysisService } from './trip-analysis.service';
import { TripAutomationService } from './trip-automation.service';

/**
 * Traçabilité fine des trajets (Palier 2) — API. Toute route exige une session ; le SERVICE applique
 * le scoping véhicule (anti-IDOR, 404 hors périmètre). Ouvert à tous les rôles (VIEWER inclus) pour
 * consulter les trajets de SES véhicules.
 */
@Controller('trip-analysis')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripAnalysisController {
  constructor(
    private readonly svc: TripAnalysisService,
    private readonly llm: TripAnalysisLlmService,
    private readonly scores: DrivingScoreService,
    private readonly fuelReport: FuelReportService,
    private readonly fuelCalibration: FuelCalibrationService,
    private readonly automation: TripAutomationService,
  ) {}

  /**
   * Automatisation des trajets (super-admin) — réglages du pipeline « recalcul → analyse → récit IA »
   * lancé automatiquement pour TOUTES les flottes. Déclaré AVANT `:tripId` (sinon capté comme un id).
   */
  @Get('automation')
  @Roles(UserRole.SUPER_ADMIN)
  getAutomation(): Promise<TripAutomationSettingsDto> {
    return this.automation.getSettings();
  }

  @Put('automation')
  @Roles(UserRole.SUPER_ADMIN)
  setAutomation(
    @Req() req: AuthenticatedRequest,
    @Body() body: SetTripAutomationSettingsDto,
  ): Promise<TripAutomationSettingsDto> {
    return this.automation.setSettings(body ?? {}, req.user.id);
  }

  /** Lance un run TOUT DE SUITE (ignore la cadence/heure) — pour tester le pipeline. */
  @Post('automation/run-now')
  @Roles(UserRole.SUPER_ADMIN)
  runAutomationNow(): Promise<TripAutomationRunStats> {
    return this.automation.runNow();
  }

  /**
   * GET /api/trip-analysis/scores — CLASSEMENT noté du score de conduite, agrégé par véhicule /
   * conducteur / groupe sur une période. Scopé au périmètre véhicules de l'utilisateur (anti-IDOR).
   * (Déclaré AVANT `:tripId` pour ne pas être capté comme un id de trajet.)
   */
  @Get('scores')
  getScores(
    @Req() req: AuthenticatedRequest,
    @Query('scope') scope?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
  ): Promise<DrivingScoresDto> {
    const s: DrivingScoreScope = scope === 'driver' || scope === 'group' ? scope : 'vehicle';
    const scopedFleet = req.user.role === UserRole.SUPER_ADMIN ? (fleetId || undefined) : undefined;
    return this.scores.scores(req.user, s, from, to, scopedFleet);
  }

  /**
   * GET /api/trip-analysis/scores/:scope/:id — score PERSO d'une entité (rang + vs moyenne), pour la
   * carte affichée dans chaque fiche détail (véhicule / conducteur / groupe). Scopé (anti-IDOR).
   */
  @Get('scores/:scope/:id')
  getEntityScore(
    @Req() req: AuthenticatedRequest,
    @Param('scope') scope: string,
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
  ): Promise<DrivingScoreDetailDto> {
    const s: DrivingScoreScope = scope === 'driver' || scope === 'group' ? scope : 'vehicle';
    const scopedFleet = req.user.role === UserRole.SUPER_ADMIN ? (fleetId || undefined) : undefined;
    return this.scores.entityScore(req.user, s, id, from, to, scopedFleet);
  }

  /** GET /api/trip-analysis/vehicle/:vehicleId — analyses récentes d'un véhicule (onglet Trajets/rapports). */
  @Get('vehicle/:vehicleId')
  listForVehicle(@Req() req: AuthenticatedRequest, @Param('vehicleId') vehicleId: string, @Query('limit') limit?: string): Promise<TripAnalysisDto[]> {
    return this.svc.listForVehicle(req.user, vehicleId, limit ? parseInt(limit, 10) : 50);
  }

  /**
   * GET /api/trip-analysis/fuel-report/:vehicleId — suivi carburant d'un véhicule (passages station,
   * prix constatés, coût estimé vs prix flotte) sur une période. Scopé véhicule (anti-IDOR).
   */
  @Get('fuel-report/:vehicleId')
  fuelReportForVehicle(
    @Req() req: AuthenticatedRequest,
    @Param('vehicleId') vehicleId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<VehicleFuelReportDto> {
    return this.fuelReport.vehicleReport(req.user, vehicleId, from, to);
  }

  /** Modèle carburant CALIBRÉ (conso estimée vs réelle « méthode du plein » + coûts au prix constaté). */
  @Get('fuel-calibration/:vehicleId')
  fuelCalibrationForVehicle(
    @Req() req: AuthenticatedRequest,
    @Param('vehicleId') vehicleId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<VehicleFuelModelDto> {
    return this.fuelCalibration.vehicleModel(req.user, vehicleId, from, to);
  }

  /** Liste des pleins renseignés d'un véhicule (période). */
  @Get('fuel-fill-ups/:vehicleId')
  fuelFillUps(
    @Req() req: AuthenticatedRequest,
    @Param('vehicleId') vehicleId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<FuelFillUpDto[]> {
    return this.fuelCalibration.listFillUps(req.user, vehicleId, from, to);
  }

  /** Enregistre un plein (méthode du plein) → recalibre la conso réelle du véhicule. */
  @Post('fuel-fill-up')
  createFillUp(@Req() req: AuthenticatedRequest, @Body() dto: UpsertFuelFillUpDto): Promise<FuelFillUpDto> {
    return this.fuelCalibration.createFillUp(req.user, dto);
  }

  /** Met à jour un plein → recalibre. */
  @Put('fuel-fill-up/:id')
  updateFillUp(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpsertFuelFillUpDto): Promise<FuelFillUpDto> {
    return this.fuelCalibration.updateFillUp(req.user, id, dto);
  }

  /** Supprime un plein → recalibre. */
  @Delete('fuel-fill-up/:id')
  deleteFillUp(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    return this.fuelCalibration.deleteFillUp(req.user, id);
  }

  /**
   * GET /api/trip-analysis/fuel-stations/map — stations agrégées pour la CARTE (passages de toute la
   * flotte accessible : fréquence + récence). Scopé au périmètre véhicules. `fleetId` = super-admin only.
   */
  @Get('fuel-stations/map')
  fuelStationsMap(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
  ): Promise<FuelStationMapPointDto[]> {
    const scopedFleet = req.user.role === UserRole.SUPER_ADMIN ? (fleetId || undefined) : undefined;
    return this.fuelReport.fleetStationsMap(req.user, from, to, scopedFleet);
  }

  /** GET /api/trip-analysis/:tripId — lit l'analyse persistée (204/null si jamais calculée). */
  @Get(':tripId')
  get(@Req() req: AuthenticatedRequest, @Param('tripId') tripId: string): Promise<TripAnalysisDto | null> {
    return this.svc.get(req.user, tripId);
  }

  /** POST /api/trip-analysis/:tripId — (ré)analyse le trajet et persiste. */
  @Post(':tripId')
  analyze(@Req() req: AuthenticatedRequest, @Param('tripId') tripId: string): Promise<TripAnalysisDto> {
    return this.svc.analyze(req.user, tripId);
  }

  /**
   * POST /api/trip-analysis/:tripId/narrate — génère le RÉCIT IA (+ Trust Score + conseils) et le
   * persiste. `provider` optionnel force un moteur (défaut = celui du switch global).
   */
  @Post(':tripId/narrate')
  narrate(
    @Req() req: AuthenticatedRequest,
    @Param('tripId') tripId: string,
    @Body() body: { provider?: AiProviderId },
  ): Promise<TripAnalysisDto> {
    // Forcer un moteur = usage INTERNE : ignoré pour un client (fleet-admin & -) qui utilise le mode
    // global (marque blanche). Le récit passe alors par le moteur / mixte réglé, de façon transparente.
    const provider = req.user.role === UserRole.SUPER_ADMIN ? body?.provider : undefined;
    if (provider && provider !== 'claude' && provider !== 'gpt') throw new BadRequestException('provider invalide');
    return this.llm.narrate(req.user, tripId, provider);
  }

  /**
   * POST /api/trip-analysis/:tripId/compare — mode « Comparer » (A/B Claude vs GPT). Usage INTERNE :
   * SUPER-ADMIN uniquement (un client ne doit jamais voir quel moteur tourne — marque blanche).
   */
  @Post(':tripId/compare')
  @Roles(UserRole.SUPER_ADMIN)
  compare(@Req() req: AuthenticatedRequest, @Param('tripId') tripId: string): Promise<TripNarrativeCompareDto> {
    return this.llm.compare(req.user, tripId);
  }
}
