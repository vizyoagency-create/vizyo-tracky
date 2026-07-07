import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AiProviderId, DrivingScoreDetailDto, DrivingScoreScope, DrivingScoresDto, TripAnalysisDto, TripNarrativeCompareDto } from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DrivingScoreService } from './driving-score.service';
import { TripAnalysisLlmService } from './trip-analysis-llm.service';
import { TripAnalysisService } from './trip-analysis.service';

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
  ) {}

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
