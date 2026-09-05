import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AiProviderId, DrivingScoreDetailDto, DrivingScoreScope, DrivingScoresDto, FuelFillUpDto, FuelStationMapPointDto, SetTripAutomationSettingsDto, TripAnalysisDto, TripAutomationBacklogDto, TripAutomationRunDto, TripAutomationRunStats, TripAutomationSettingsDto, TripNarrativeCompareDto, UpsertFuelFillUpDto, VehicleFuelModelDto, VehicleFuelReportDto } from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DepotScopeGuard } from '../depot/depot-scope.guard';
import { ListTripAnalysesDto } from './dto/list-trip-analyses.dto';
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
 *
 * ⚠️ FERMÉ AU RÔLE DEPOT (espace dépôt 2026-08, revue A1.4).
 *
 * Huit routes de ce contrôleur sont gardées par `trips_view` — et `trips_view` est
 * OUVERTE à un dépôt (A1 § 2), parce qu'il doit voir les trajets de SES missions.
 * Sans le garde ci-dessous, un dépôt authentifié atteignait donc : les scores de
 * conduite de toute la flotte, les rapports carburant par véhicule, la calibration
 * des pleins et la carte des stations. Exactement ce qu'A1 § 4 interdit — « leurs DTO
 * exposent des champs qu'un dépôt ne doit pas voir (coûts, scores) » — et ce qu'A3 § 7
 * réaffirme : « aucune donnée de coût, de score, de consommation ».
 *
 * `DepotScopeGuard` est en refus par défaut : sans décorateur `@DepotScope`, il rend
 * 403 à un DEPOT et laisse passer tous les autres rôles sans rien changer. Le dépôt
 * consulte ses trajets par son endpoint dédié `/depot/trips/:id` (lot A3), dont le DTO
 * est restreint.
 */
/**
 * Portées de notation acceptées dans l'URL ; tout inconnu retombe sur `vehicle`.
 * ⚠️ UNE seule liste pour `/scores` ET `/scores/:scope/:id` : la 4ᵉ portée avait été ajoutée
 * à l'une sans l'autre, et la fiche de détail aurait silencieusement répondu « véhicule ».
 */
export const PORTEES_NOTATION: readonly DrivingScoreScope[] = ['vehicle', 'driver', 'group', 'attribution'];
export function parseScope(brut: string | undefined): DrivingScoreScope {
  return brut != null && (PORTEES_NOTATION as readonly string[]).includes(brut) ? (brut as DrivingScoreScope) : 'vehicle';
}

@Controller('trip-analysis')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, DepotScopeGuard)
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

  /** Historique des passages (quand / pour qui / quoi + récits produits cliquables). */
  @Get('automation/runs')
  @Roles(UserRole.SUPER_ADMIN)
  listAutomationRuns(@Query('limit') limit?: string): Promise<TripAutomationRunDto[]> {
    return this.automation.listRuns(limit ? parseInt(limit, 10) : 30);
  }

  /** Reste à faire du pipeline par société (sans analyse / sans récit / figés) — le chiffre qui doit baisser. */
  @Get('automation/backlog')
  @Roles(UserRole.SUPER_ADMIN)
  automationBacklog(): Promise<TripAutomationBacklogDto> {
    return this.automation.backlog();
  }

  /**
   * GET /api/trip-analysis/scores — CLASSEMENT noté du score de conduite, agrégé par véhicule /
   * conducteur / groupe sur une période. Scopé au périmètre véhicules de l'utilisateur (anti-IDOR).
   * (Déclaré AVANT `:tripId` pour ne pas être capté comme un id de trajet.)
   */
  @Get('scores')
  @RequirePermissions('trips_view')
  getScores(
    @Req() req: AuthenticatedRequest,
    @Query('scope') scope?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
  ): Promise<DrivingScoresDto> {
    const s = parseScope(scope);
    const scopedFleet = req.user.role === UserRole.SUPER_ADMIN ? (fleetId || undefined) : undefined;
    return this.scores.scores(req.user, s, from, to, scopedFleet);
  }

  /**
   * GET /api/trip-analysis/scores/:scope/:id — score PERSO d'une entité (rang + vs moyenne), pour la
   * carte affichée dans chaque fiche détail (véhicule / conducteur / groupe). Scopé (anti-IDOR).
   */
  @Get('scores/:scope/:id')
  @RequirePermissions('trips_view')
  getEntityScore(
    @Req() req: AuthenticatedRequest,
    @Param('scope') scope: string,
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
  ): Promise<DrivingScoreDetailDto> {
    const s = parseScope(scope);
    const scopedFleet = req.user.role === UserRole.SUPER_ADMIN ? (fleetId || undefined) : undefined;
    return this.scores.entityScore(req.user, s, id, from, to, scopedFleet);
  }

  /** GET /api/trip-analysis/vehicle/:vehicleId — analyses récentes d'un véhicule (onglet Trajets/rapports). */
  @Get('vehicle/:vehicleId')
  @RequirePermissions('trips_view')
  listForVehicle(@Req() req: AuthenticatedRequest, @Param('vehicleId') vehicleId: string, @Query('limit') limit?: string): Promise<TripAnalysisDto[]> {
    return this.svc.listForVehicle(req.user, vehicleId, limit ? parseInt(limit, 10) : 50);
  }

  /**
   * POST /api/trip-analysis/by-trips — analyses des trajets AFFICHÉS, en un appel.
   * Lecture seule malgré le POST (cf. `ListTripAnalysesDto`). Scopée : les trajets hors
   * périmètre sont omis, jamais renvoyés.
   *
   * ⚠️ DOIT rester déclarée AVANT `@Post(':tripId')`, sinon Nest y voit un trajet
   * nommé « by-trips » et déclenche une (ré)analyse.
   */
  @Post('by-trips')
  @RequirePermissions('trips_view')
  listForTrips(@Req() req: AuthenticatedRequest, @Body() dto: ListTripAnalysesDto): Promise<TripAnalysisDto[]> {
    return this.svc.listForTrips(req.user, dto.tripIds);
  }

  /**
   * GET /api/trip-analysis/fuel-report/:vehicleId — suivi carburant d'un véhicule (passages station,
   * prix constatés, coût estimé vs prix flotte) sur une période. Scopé véhicule (anti-IDOR).
   */
  @Get('fuel-report/:vehicleId')
  @RequirePermissions('trips_view')
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
  @RequirePermissions('trips_view')
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
  @RequirePermissions('trips_view')
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
  @RequirePermissions('fuel_manage')
  createFillUp(@Req() req: AuthenticatedRequest, @Body() dto: UpsertFuelFillUpDto): Promise<FuelFillUpDto> {
    return this.fuelCalibration.createFillUp(req.user, dto);
  }

  /** Met à jour un plein → recalibre. */
  @Put('fuel-fill-up/:id')
  @RequirePermissions('fuel_manage')
  updateFillUp(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() dto: UpsertFuelFillUpDto): Promise<FuelFillUpDto> {
    return this.fuelCalibration.updateFillUp(req.user, id, dto);
  }

  /** Supprime un plein → recalibre. */
  @Delete('fuel-fill-up/:id')
  @RequirePermissions('fuel_manage')
  deleteFillUp(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    return this.fuelCalibration.deleteFillUp(req.user, id);
  }

  /**
   * GET /api/trip-analysis/fuel-stations/map — stations agrégées pour la CARTE (passages de toute la
   * flotte accessible : fréquence + récence). Scopé au périmètre véhicules. `fleetId` = super-admin only.
   */
  @Get('fuel-stations/map')
  @RequirePermissions('trips_view')
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
  @RequirePermissions('trips_view')
  get(@Req() req: AuthenticatedRequest, @Param('tripId') tripId: string): Promise<TripAnalysisDto | null> {
    return this.svc.get(req.user, tripId);
  }

  /**
   * POST /api/trip-analysis/:tripId — (ré)analyse le trajet et persiste.
   *
   * ⚠️ ÉCRITURE, pas lecture : l'appel relit jusqu'à cinq mille positions, réinterroge les
   * limites de vitesse, et ÉCRASE tous les chiffres de l'analyse existante. Il était ouvert à
   * `trips_view`, c'est-à-dire à quiconque peut simplement consulter un trajet — un rôle de
   * lecture pouvait donc remplacer les chiffres d'une analyse pour toute la société. Réservé
   * aux rôles qui gèrent la flotte, comme la suppression ou la réaffectation d'un trajet.
   */
  @Post(':tripId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('trips_view')
  analyze(@Req() req: AuthenticatedRequest, @Param('tripId') tripId: string): Promise<TripAnalysisDto> {
    return this.svc.analyze(req.user, tripId);
  }

  /**
   * POST /api/trip-analysis/:tripId/narrate — génère le RÉCIT IA (+ Trust Score + conseils) et le
   * persiste. `provider` optionnel force un moteur (défaut = celui du switch global).
   */
  @Post(':tripId/narrate')
  @RequirePermissions('ai_narrate')
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
