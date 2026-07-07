import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AiProviderId, TripAnalysisDto, TripNarrativeCompareDto } from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
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
  ) {}

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
    const provider = body?.provider;
    if (provider && provider !== 'claude' && provider !== 'gpt') throw new BadRequestException('provider invalide');
    return this.llm.narrate(req.user, tripId, provider);
  }

  /**
   * POST /api/trip-analysis/:tripId/compare — mode « Comparer » : le MÊME trajet analysé par Claude
   * ET GPT, côte à côte (coût ×2). Réservé aux admins (maîtrise du coût).
   */
  @Post(':tripId/compare')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  compare(@Req() req: AuthenticatedRequest, @Param('tripId') tripId: string): Promise<TripNarrativeCompareDto> {
    return this.llm.compare(req.user, tripId);
  }
}
