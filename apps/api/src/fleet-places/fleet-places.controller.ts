import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateFleetPlaceDto, UpdateFleetPlaceDto } from './dto/fleet-place.dto';
import { FleetPlacesService } from './fleet-places.service';
import { PlaceAnalysisService } from './place-analysis.service';

/**
 * Lieux clés (2026-07) — stations-service validées par la flotte + parkings / stationnements
 * récurrents. Lecture : `places_view`. Écriture : `places_manage` (accordée aux managers par
 * défaut). Le scoping société/véhicules est appliqué côté service (anti-IDOR).
 */
@Controller('fleet-places')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class FleetPlacesController {
  constructor(
    private readonly places: FleetPlacesService,
    private readonly placeAnalysis: PlaceAnalysisService,
  ) {}

  /**
   * L'analyse IA est-elle proposable ? Sert à MASQUER l'affordance côté UI plutôt qu'à la laisser
   * échouer : si l'IA est coupée (clé absente, kill-switch owner, société sans option IA), le
   * client ne doit RIEN afficher. Route STATIQUE → avant tout segment dynamique.
   * `places_view` suffit : c'est un état d'UI, pas un déclenchement.
   */
  @Get('ai-status')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('places_view')
  async aiStatus(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    const scoped = this.places.resolveFleetId(req.user, fleetId);
    return { enabled: await this.placeAnalysis.isAvailable(scoped) };
  }

  /**
   * Stations-service REGROUPÉES (une par lieu) : passages, qui est passé et combien de fois.
   * Seuls les VRAIS arrêts (≥ `minStopMin`, 4 min par défaut) sont comptés.
   * Route STATIQUE → déclarée avant tout segment dynamique.
   */
  @Get('stations')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('places_view')
  stationGroups(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
    @Query('minStopMin') minStopMin?: string,
  ) {
    const min = minStopMin ? Number(minStopMin) : undefined;
    return this.places.stationGroups(req.user, {
      fromIso: from,
      toIso: to,
      fleetId,
      minStopMin: Number.isFinite(min) ? min : undefined,
    });
  }

  /** Lieux clés de la flotte (stations validées + parkings + dépôts). */
  @Get()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('places_view')
  list(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.places.list(req.user, fleetId);
  }

  /** Crée un lieu : parking/stationnement à la main, ou validation d'une station détectée. */
  @Post()
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('places_manage')
  create(@Body() dto: CreateFleetPlaceDto, @Req() req: AuthenticatedRequest) {
    return this.places.create(req.user, dto);
  }

  /**
   * Faits OpenStreetMap d'un lieu : horaires, services, carburants, contact, capacité, image libre.
   * GRATUIT et SANS IA → gardé par `places_view` seulement (aucun contrôle IA nécessaire ici).
   */
  @Get(':id/facts')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('places_view')
  facts(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.places.facts(req.user, id);
  }

  /** Analyse IA COURANTE d'un lieu (null si jamais analysé). Lecture seule : aucun appel IA, donc
   *  consultable même si l'IA a été coupée depuis (l'historique reste lisible). */
  @Get(':id/analysis')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('places_view')
  analysis(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.placeAnalysis.get(req.user, id);
  }

  /**
   * Lance (ou relance) l'analyse IA d'un lieu — CONSOMME DES TOKENS, d'où sa propre permission
   * `places_analyze` (séparée de `places_manage`). Le service revérifie la disponibilité IA :
   * la permission autorise la personne, elle n'active pas l'IA de la société.
   */
  @Post(':id/analyze')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('places_analyze')
  analyze(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.placeAnalysis.analyze(req.user, id, 'manual');
  }

  /** Modifie un lieu (nom, nature, position, rayon, note). */
  @Patch(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('places_manage')
  update(@Param('id') id: string, @Body() dto: UpdateFleetPlaceDto, @Req() req: AuthenticatedRequest) {
    return this.places.update(req.user, id, dto);
  }

  /** Retire un lieu (dévalide une station, ou efface un parking). */
  @Delete(':id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('places_manage')
  remove(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.places.remove(req.user, id);
  }
}
