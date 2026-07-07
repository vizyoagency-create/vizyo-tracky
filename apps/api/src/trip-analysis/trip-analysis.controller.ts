import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { TripAnalysisDto } from '@vizyo/tracky-shared';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TripAnalysisService } from './trip-analysis.service';

/**
 * Traçabilité fine des trajets (Palier 2) — API. Toute route exige une session ; le SERVICE applique
 * le scoping véhicule (anti-IDOR, 404 hors périmètre). Ouvert à tous les rôles (VIEWER inclus) pour
 * consulter les trajets de SES véhicules.
 */
@Controller('trip-analysis')
@UseGuards(JwtAuthGuard)
export class TripAnalysisController {
  constructor(private readonly svc: TripAnalysisService) {}

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
}
